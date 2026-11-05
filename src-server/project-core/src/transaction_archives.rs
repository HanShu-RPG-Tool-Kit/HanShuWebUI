//! Read-only archive diagnostics and conservative historical-receipt quarantine.
//! A tombstone is published before moving evidence, so a crash never frees an ID.
use super::*;
use std::time::{Instant, UNIX_EPOCH};

const TRANSACTIONS: &str = ".hanshu/service/file-transactions";
const QUARANTINE: &str = ".hanshu/service/file-transactions/archive-quarantine";

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveStats {
    pub archive_count: u64,
    pub legacy_count: u64,
    pub valid_count: u64,
    pub corrupt_count: u64,
    pub quarantined_count: u64,
    pub protected_count: u64,
    pub unsafe_count: u64,
    pub io_error_count: u64,
    /// Physical receipt bytes, including retained quarantine evidence; no journal bytes.
    pub compressed_bytes: u64,
    /// Successfully decoded bytes, or the bounded prefix read before decode failed.
    pub uncompressed_bytes: u64,
    pub oldest_modified_at_ms: Option<u64>,
    pub newest_modified_at_ms: Option<u64>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ArchiveDiagnostic {
    pub relative_path: String,
    pub transaction_id: Option<String>,
    /// valid, corrupt, quarantined, protected, unsafe, or io_error.
    pub status: String,
    pub code: Option<String>,
    pub message: Option<String>,
    pub compressed_bytes: u64,
    pub uncompressed_bytes: Option<u64>,
    pub modified_at_ms: Option<u64>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveDiagnostics {
    pub scanned_at_ms: u64,
    pub scan_duration_ms: u64,
    pub stats: ArchiveStats,
    pub entries: Vec<ArchiveDiagnostic>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Tombstone {
    schema: u32,
    hash: String,
    quarantined_at_ms: u64,
    diagnostic: ArchiveDiagnostic,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct RevisionWatermark {
    schema: u32,
    revision: u64,
}

fn read_revision_watermark(root: &Path) -> std::result::Result<Option<u64>, ArchiveDiagnostic> {
    let path = root.join(TRANSACTIONS).join("revision-watermark");
    let entry = ArchiveDiagnostic::new(root, &path);
    match fs::symlink_metadata(&path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(entry.fail("io_error", "io_error", error.to_string())),
        Ok(_) => {}
    }
    let meta = inspect_metadata(root, &path, false)?;
    if meta.len() > 1024 {
        return Err(entry.fail(
            "protected",
            "invalid_revision_watermark",
            "事务版本高水位过大",
        ));
    }
    let bytes = fs::read(&path).map_err(|error| {
        entry
            .clone()
            .fail("io_error", "io_error", error.to_string())
    })?;
    let watermark: RevisionWatermark = serde_json::from_slice(&bytes).map_err(|_| {
        entry.clone().fail(
            "protected",
            "invalid_revision_watermark",
            "事务版本高水位损坏",
        )
    })?;
    if watermark.schema != 1 || watermark.revision == 0 || watermark.revision == u64::MAX {
        return Err(entry.fail(
            "protected",
            "invalid_revision_watermark",
            "事务版本高水位无效",
        ));
    }
    Ok(Some(watermark.revision))
}

impl ArchiveDiagnostic {
    fn new(root: &Path, path: &Path) -> Self {
        Self {
            relative_path: path
                .strip_prefix(root)
                .unwrap_or(path)
                .to_string_lossy()
                .replace('\\', "/"),
            transaction_id: None,
            status: "valid".into(),
            code: None,
            message: None,
            compressed_bytes: 0,
            uncompressed_bytes: None,
            modified_at_ms: None,
        }
    }

    fn fail(mut self, status: &str, code: &str, message: impl Into<String>) -> Self {
        self.status = status.into();
        self.code = Some(code.into());
        self.message = Some(message.into());
        self
    }

    pub(super) fn error(&self) -> Error {
        let identity = self
            .transaction_id
            .as_ref()
            .map(|id| format!(" (transactionId={id})"))
            .unwrap_or_default();
        Error::new(
            "storage",
            format!(
                "{}{}: {}",
                self.relative_path,
                identity,
                self.message.as_deref().unwrap_or("事务归档不可用")
            ),
        )
    }
}

impl ArchiveDiagnostics {
    pub(super) fn recount(&mut self) {
        self.stats = ArchiveStats::default();
        for entry in &self.entries {
            if entry.relative_path.ends_with(".json.gz") {
                self.stats.archive_count += 1;
            } else if receipt_hash(Path::new(&entry.relative_path), true).is_some() {
                self.stats.legacy_count += 1;
            }
            match entry.status.as_str() {
                "valid" => self.stats.valid_count += 1,
                "corrupt" => self.stats.corrupt_count += 1,
                "quarantined" => self.stats.quarantined_count += 1,
                "protected" => self.stats.protected_count += 1,
                "unsafe" => self.stats.unsafe_count += 1,
                "io_error" => self.stats.io_error_count += 1,
                _ => {}
            }
            self.stats.compressed_bytes = self
                .stats
                .compressed_bytes
                .saturating_add(entry.compressed_bytes);
            self.stats.uncompressed_bytes = self
                .stats
                .uncompressed_bytes
                .saturating_add(entry.uncompressed_bytes.unwrap_or(0));
            if let Some(time) = entry.modified_at_ms {
                self.stats.oldest_modified_at_ms = Some(
                    self.stats
                        .oldest_modified_at_ms
                        .map_or(time, |old| old.min(time)),
                );
                self.stats.newest_modified_at_ms = Some(
                    self.stats
                        .newest_modified_at_ms
                        .map_or(time, |old| old.max(time)),
                );
            }
        }
    }
}

fn hash_ok(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn receipt_hash(path: &Path, legacy: bool) -> Option<String> {
    let name = path.file_name()?.to_str()?;
    let hash = name.strip_suffix(if legacy { ".json" } else { ".json.gz" })?;
    hash_ok(hash).then(|| hash.into())
}

fn expected_source(hash: &str, legacy: bool) -> String {
    if legacy {
        format!("{TRANSACTIONS}/{hash}.json")
    } else {
        format!("{TRANSACTIONS}/archive/{}/{hash}.json.gz", &hash[..2])
    }
}

fn inspect_metadata(
    root: &Path,
    path: &Path,
    directory: bool,
) -> std::result::Result<fs::Metadata, ArchiveDiagnostic> {
    let entry = ArchiveDiagnostic::new(root, path);
    let meta = fs::symlink_metadata(path).map_err(|error| {
        entry
            .clone()
            .fail("io_error", "io_error", error.to_string())
    })?;
    if reparse(&meta) || (directory && !meta.is_dir()) || (!directory && !meta.is_file()) {
        return Err(entry.fail(
            "unsafe",
            "unsafe_path",
            "事务路径类型无效或为符号链接/目录联接",
        ));
    }
    Ok(meta)
}

/// Filesystem reads finish before decoding, so an I/O error is never mistaken for corrupt gzip.
pub(super) fn read_record(
    root: &Path,
    path: &Path,
    legacy: bool,
) -> std::result::Result<(TransactionRecord, ArchiveDiagnostic), ArchiveDiagnostic> {
    let mut entry = ArchiveDiagnostic::new(root, path);
    let meta = inspect_metadata(root, path, false)?;
    entry.compressed_bytes = meta.len();
    entry.modified_at_ms = meta
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|time| time.as_millis() as u64);
    let Some(hash) = receipt_hash(path, legacy) else {
        return Err(entry.fail("unsafe", "unsafe_path", "事务归档名称无效"));
    };
    if entry.relative_path != expected_source(&hash, legacy) {
        return Err(entry.fail("unsafe", "unsafe_path", "事务归档分片或路径无效"));
    }
    let limit = MAX_RECORD_BYTES + if legacy { 0 } else { 1024 * 1024 };
    if meta.len() > limit as u64 {
        return Err(entry.fail("corrupt", "receipt_too_large", "事务回执超过单条大小限制"));
    }
    let mut raw = Vec::new();
    fs::File::open(path)
        .and_then(|file| file.take((limit + 1) as u64).read_to_end(&mut raw))
        .map_err(|error| {
            entry
                .clone()
                .fail("io_error", "io_error", error.to_string())
        })?;
    if raw.len() > limit {
        return Err(entry.fail(
            "corrupt",
            "receipt_too_large",
            "事务回执读取时超过单条大小限制",
        ));
    }
    let bytes = if legacy {
        raw
    } else {
        let mut bytes = Vec::new();
        let decoded = flate2::read::MultiGzDecoder::new(raw.as_slice())
            .take((MAX_RECORD_BYTES + 1) as u64)
            .read_to_end(&mut bytes);
        entry.uncompressed_bytes = Some(bytes.len() as u64);
        if decoded.is_err() {
            return Err(entry.fail("corrupt", "invalid_gzip", "事务归档 gzip 损坏或截断"));
        }
        bytes
    };
    entry.uncompressed_bytes = Some(bytes.len() as u64);
    if bytes.len() > MAX_RECORD_BYTES {
        return Err(entry.fail(
            "corrupt",
            "receipt_too_large",
            "事务回执解压后超过单条大小限制",
        ));
    }
    let parsed = serde_json::from_slice::<TransactionRecord>(&bytes);
    // Only invalid structures need a second parse to salvage a known ID; healthy
    // archives decode directly once without allocating a parallel JSON value tree.
    let identity = match &parsed {
        Ok(record) => Some(record.receipt.transaction_id.clone()),
        Err(_) => serde_json::from_slice::<serde_json::Value>(&bytes)
            .ok()
            .and_then(|value| value["receipt"]["transactionId"].as_str().map(String::from)),
    };
    if let Some(id) = identity.filter(|id| transaction_id_ok(id).is_ok()) {
        entry.transaction_id = Some(id.clone());
        if hex_digest(id.as_bytes()) != hash {
            return Err(entry.fail(
                "unsafe",
                "receipt_identity_mismatch",
                "事务回执编号与归档名称不一致",
            ));
        }
    }
    let record = parsed.map_err(|_| {
        entry
            .clone()
            .fail("corrupt", "invalid_record", "事务记录 JSON 或结构损坏")
    })?;
    if record
        .receipt
        .tree
        .as_ref()
        .is_some_and(|tree| tree.entries.iter().any(|file| path_ok(&file.path).is_err()))
    {
        return Err(entry.fail("unsafe", "unsafe_receipt_path", "持久事务清单含非法路径"));
    }
    if let Some(result) = &record.receipt.progress_result {
        if path_ok(&result.path).is_err()
            || result
                .languages
                .iter()
                .any(|language| path_ok(&language.path).is_err())
        {
            return Err(entry.fail("unsafe", "unsafe_receipt_path", "持久进度回执含非法路径"));
        }
    }
    record.validate().map_err(|error| {
        entry
            .clone()
            .fail("corrupt", "invalid_record", error.message)
    })?;
    entry.transaction_id = Some(record.receipt.transaction_id.clone());
    Ok((record, entry))
}

fn children(root: &Path, path: &Path, report: &mut ArchiveDiagnostics) -> Vec<PathBuf> {
    let mut paths = Vec::new();
    match fs::read_dir(path) {
        Ok(entries) => {
            for entry in entries {
                match entry {
                    Ok(entry) => paths.push(entry.path()),
                    Err(error) => report.entries.push(ArchiveDiagnostic::new(root, path).fail(
                        "io_error",
                        "io_error",
                        error.to_string(),
                    )),
                }
            }
        }
        Err(error) => report.entries.push(ArchiveDiagnostic::new(root, path).fail(
            "io_error",
            "io_error",
            error.to_string(),
        )),
    }
    paths.sort();
    paths
}

fn optional_directory(root: &Path, path: &Path, report: &mut ArchiveDiagnostics) -> bool {
    match fs::symlink_metadata(path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
        _ => match inspect_metadata(root, path, true) {
            Ok(_) => true,
            Err(error) => {
                report.entries.push(error);
                false
            }
        },
    }
}

fn read_tombstone(root: &Path, path: &Path) -> std::result::Result<Tombstone, ArchiveDiagnostic> {
    let entry = ArchiveDiagnostic::new(root, path);
    let meta = inspect_metadata(root, path, false)?;
    if meta.len() > 64 * 1024 {
        return Err(entry.fail(
            "unsafe",
            "invalid_tombstone",
            "隔离标记过大；拒绝释放事务编号",
        ));
    }
    let bytes = fs::read(path).map_err(|error| {
        entry
            .clone()
            .fail("io_error", "io_error", error.to_string())
    })?;
    let tombstone: Tombstone = serde_json::from_slice(&bytes).map_err(|_| {
        entry.clone().fail(
            "unsafe",
            "invalid_tombstone",
            "隔离标记损坏；拒绝释放事务编号",
        )
    })?;
    let hash = &tombstone.hash;
    let valid = tombstone.schema == 1
        && hash_ok(hash)
        && path == root.join(QUARANTINE).join(format!("{hash}.tombstone.json"))
        && [expected_source(hash, true), expected_source(hash, false)]
            .contains(&tombstone.diagnostic.relative_path)
        && tombstone
            .diagnostic
            .transaction_id
            .as_deref()
            .is_none_or(|id| transaction_id_ok(id).is_ok() && hex_digest(id.as_bytes()) == *hash);
    if !valid {
        return Err(entry.fail("unsafe", "invalid_tombstone", "隔离标记身份或路径无效"));
    }
    Ok(tombstone)
}

/// Inspect receipts without acquiring a service lock, recovering a journal, or writing anything.
/// This also works while the project cannot open. Concurrent writers may make the report stale.
pub fn inspect_transaction_archives(root: &Path) -> Result<ArchiveDiagnostics> {
    scan_transaction_archives(root, |_, _, _| {})
}

pub(super) fn scan_transaction_archives(
    root: &Path,
    mut valid: impl FnMut(TransactionRecord, usize, bool),
) -> Result<ArchiveDiagnostics> {
    let started = Instant::now();
    let root = root.canonicalize()?;
    let mut report = ArchiveDiagnostics {
        scanned_at_ms: crate::now_ms(),
        ..Default::default()
    };
    for part in [".hanshu", ".hanshu/service", TRANSACTIONS] {
        if !optional_directory(&root, &root.join(part), &mut report) {
            report.recount();
            report.scan_duration_ms = started.elapsed().as_millis() as u64;
            return Ok(report);
        }
    }

    // Establish every recovery dependency before deciding which bad contents are historical.
    let journal_path = root.join(".hanshu/service/file-undo.json");
    let mut protected_hash = None;
    let mut unknown_journal = false;
    match fs::symlink_metadata(&journal_path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        _ => {
            let checked = (|| {
                inspect_metadata(&root, &journal_path, false).map_err(|e| e.error())?;
                let bytes = fs::read(&journal_path)?;
                let journal: CommitJournal = serde_json::from_slice(&bytes)
                    .map_err(|_| Error::new("storage", "事务恢复日志损坏"))?;
                journal.transaction.validate()?;
                require(
                    journal.transaction.receipt.status == FileTransactionStatus::Committed,
                    "storage",
                    "事务恢复日志缺少有效提交决议",
                )?;
                ProjectFiles::undo_values(&journal)?;
                Ok::<_, Error>(journal.transaction.receipt.transaction_id)
            })();
            match checked {
                Ok(id) => protected_hash = Some(hex_digest(id.as_bytes())),
                Err(error) => {
                    unknown_journal = true;
                    report
                        .entries
                        .push(ArchiveDiagnostic::new(&root, &journal_path).fail(
                            "protected",
                            "invalid_journal",
                            error.message,
                        ));
                }
            }
        }
    }

    if let Err(error) = read_revision_watermark(&root) {
        report.entries.push(error);
    }

    let quarantine = root.join(QUARANTINE);
    if optional_directory(&root, &quarantine, &mut report) {
        let paths = children(&root, &quarantine, &mut report);
        for path in &paths {
            if path
                .file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| n.ends_with(".tombstone.json"))
            {
                match read_tombstone(&root, path) {
                    Ok(tombstone) => {
                        let mut entry = tombstone.diagnostic;
                        entry.status = if unknown_journal
                            || protected_hash.as_ref() == Some(&tombstone.hash)
                        {
                            "protected"
                        } else {
                            "quarantined"
                        }
                        .into();
                        report.entries.push(entry);
                    }
                    Err(error) => report.entries.push(error),
                }
            } else {
                let hash = receipt_hash(path, false).or_else(|| {
                    path.file_name()?
                        .to_str()?
                        .strip_suffix(".legacy.json")
                        .filter(|hash| hash_ok(hash))
                        .map(String::from)
                });
                match hash {
                    Some(hash)
                        if paths.contains(&quarantine.join(format!("{hash}.tombstone.json"))) =>
                    {
                        if let Err(error) = inspect_metadata(&root, path, false) {
                            report.entries.push(error);
                        }
                    }
                    _ => report
                        .entries
                        .push(ArchiveDiagnostic::new(&root, path).fail(
                            "unsafe",
                            "orphan_quarantine",
                            "隔离证据缺少有效标记",
                        )),
                }
            }
        }
    }

    let mut candidates = Vec::new();
    for path in children(&root, &root.join(TRANSACTIONS), &mut report) {
        if path.extension().and_then(|ext| ext.to_str()) == Some("json") {
            candidates.push((path, true));
        } else {
            match fs::symlink_metadata(&path) {
                Ok(meta) if reparse(&meta) => {
                    report
                        .entries
                        .push(ArchiveDiagnostic::new(&root, &path).fail(
                            "unsafe",
                            "unsafe_path",
                            "事务记录不能是链接",
                        ))
                }
                Ok(_) => {}
                Err(error) => report
                    .entries
                    .push(ArchiveDiagnostic::new(&root, &path).fail(
                        "io_error",
                        "io_error",
                        error.to_string(),
                    )),
            }
        }
    }
    let archive = root.join(TRANSACTIONS).join("archive");
    if optional_directory(&root, &archive, &mut report) {
        for shard in children(&root, &archive, &mut report) {
            if let Err(error) = inspect_metadata(&root, &shard, true) {
                report.entries.push(error);
                continue;
            }
            if !shard
                .file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| {
                    name.len() == 2
                        && name
                            .bytes()
                            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
                })
            {
                report
                    .entries
                    .push(ArchiveDiagnostic::new(&root, &shard).fail(
                        "unsafe",
                        "unsafe_path",
                        "事务归档分片名称无效",
                    ));
                continue;
            }
            candidates.extend(
                children(&root, &shard, &mut report)
                    .into_iter()
                    .map(|path| (path, false)),
            );
        }
    }
    let mut legacy_copies = BTreeMap::new();
    for (path, legacy) in candidates {
        let mut entry = match read_record(&root, &path, legacy) {
            Ok((record, entry)) => {
                let hash = hex_digest(record.receipt.transaction_id.as_bytes());
                if legacy || legacy_copies.contains_key(&hash) {
                    let digest = hex_digest(
                        &serde_json::to_vec(&record)
                            .map_err(|_| Error::new("storage", "事务结果编码失败"))?,
                    );
                    if legacy {
                        legacy_copies.insert(hash, digest);
                    } else if legacy_copies.get(&hash) != Some(&digest) {
                        report.entries.push(entry.fail(
                            "unsafe",
                            "inconsistent_receipts",
                            "旧事务与压缩归档回执不一致，拒绝覆盖",
                        ));
                        continue;
                    }
                }
                valid(
                    record,
                    entry.uncompressed_bytes.unwrap_or(0) as usize,
                    legacy,
                );
                entry
            }
            Err(entry) => entry,
        };
        if entry.status == "corrupt"
            && (unknown_journal || protected_hash == receipt_hash(&path, legacy))
        {
            entry.status = "protected".into();
            entry.code = Some("recovery_receipt_corrupt".into());
        }
        report.entries.push(entry);
    }
    report.recount();
    report.scan_duration_ms = started.elapsed().as_millis() as u64;
    Ok(report)
}

impl ProjectFiles {
    pub(super) fn initialize_revision_watermark(
        &mut self,
        report: &ArchiveDiagnostics,
    ) -> Result<()> {
        if let Some(entry) = report
            .entries
            .iter()
            .find(|entry| matches!(entry.status.as_str(), "unsafe" | "io_error" | "protected"))
        {
            return Err(entry.error());
        }
        let persisted = read_revision_watermark(&self.root).map_err(|entry| entry.error())?;
        // Before this watermark existed, revisions started at 1 and each commit
        // added exactly one, with no receipt pruning. Counting all retained receipts
        // bounds even a wholly unreadable last receipt; duplicate copies only raise
        // this conservative upgrade floor. Future gaps are preserved by the watermark.
        let floor = persisted.unwrap_or_else(|| {
            report
                .stats
                .archive_count
                .saturating_add(report.stats.legacy_count)
                .saturating_add(1)
        });
        self.reserve_transaction_revision(self.revision.max(floor))
    }

    pub(super) fn reserve_transaction_revision(&mut self, revision: u64) -> Result<()> {
        require(
            revision > 0 && revision < u64::MAX,
            "storage",
            "事务版本已超过可分配范围",
        )?;
        let previous = read_revision_watermark(&self.root).map_err(|entry| entry.error())?;
        let revision = revision.max(previous.unwrap_or(1));
        if previous != Some(revision) {
            let path = self.root.join(TRANSACTIONS).join("revision-watermark");
            let bytes = serde_json::to_vec(&RevisionWatermark {
                schema: 1,
                revision,
            })
            .map_err(|_| Error::new("storage", "事务版本高水位编码失败"))?;
            self.atomic(&path, &bytes)?;
        }
        self.revision = self.revision.max(revision);
        Ok(())
    }

    pub(super) fn check_quarantined(&self, id: &str) -> Result<()> {
        let directory = self.root.join(QUARANTINE);
        match fs::symlink_metadata(&directory) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(error.into()),
            Ok(_) => Self::checked_directory(&directory, false)?,
        }
        let path = directory.join(format!("{}.tombstone.json", hex_digest(id.as_bytes())));
        match fs::symlink_metadata(&path) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(error.into()),
            Ok(_) => {
                let tombstone = read_tombstone(&self.root, &path).map_err(|entry| entry.error())?;
                Err(Error::new("receipt_quarantined", format!("事务 {id} 的历史回执已隔离（{}）；原编号仍被保留，请联系工程管理员检查归档，不能重新执行或撤销此事务", tombstone.diagnostic.relative_path)))
            }
        }
    }

    pub(super) fn quarantine_archives(&self, report: &mut ArchiveDiagnostics) -> Result<()> {
        // One unsafe/I/O/recovery dependency prevents all quarantine in this scan.
        if let Some(entry) = report
            .entries
            .iter()
            .find(|entry| matches!(entry.status.as_str(), "unsafe" | "io_error" | "protected"))
        {
            return Err(entry.error());
        }
        for entry in &mut report.entries {
            if !matches!(entry.status.as_str(), "corrupt" | "quarantined") {
                continue;
            }
            let legacy = !entry.relative_path.ends_with(".json.gz");
            let source = self.root.join(&entry.relative_path);
            let hash = receipt_hash(&source, legacy).ok_or_else(|| entry.error())?;
            let directory = self.root.join(QUARANTINE);
            Self::checked_directory(&directory, true)?;
            let marker = directory.join(format!("{hash}.tombstone.json"));
            match fs::symlink_metadata(&marker) {
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    let tombstone = Tombstone {
                        schema: 1,
                        hash: hash.clone(),
                        quarantined_at_ms: crate::now_ms(),
                        diagnostic: entry.clone(),
                    };
                    self.atomic(
                        &marker,
                        &serde_json::to_vec(&tombstone).map_err(|_| entry.error())?,
                    )?;
                }
                Err(error) => return Err(error.into()),
                Ok(_) => {
                    read_tombstone(&self.root, &marker).map_err(|entry| entry.error())?;
                }
            }
            let target = directory.join(format!(
                "{hash}.{}",
                if legacy { "legacy.json" } else { "json.gz" }
            ));
            match fs::symlink_metadata(&source) {
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(error.into()),
                Ok(_) => {
                    inspect_metadata(&self.root, &source, false).map_err(|entry| entry.error())?;
                    match fs::symlink_metadata(&target) {
                        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                            fs::rename(&source, &target)?
                        }
                        Err(error) => return Err(error.into()),
                        Ok(_) => return Err(Error::new("storage", "隔离目标已存在，拒绝覆盖证据")),
                    }
                }
            }
            entry.status = "quarantined".into();
        }
        report.recount();
        Ok(())
    }
}
