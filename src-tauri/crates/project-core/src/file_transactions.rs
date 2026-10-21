//! Immutable receipts and the durable commit decision share the file undo journal.
//! A prepared journal rolls back; a committed journal publishes its receipt without replaying writes.
use super::*;
use flate2::{read::GzDecoder, write::GzEncoder, Compression};
use std::{collections::VecDeque, io::Read};

const MAX_HOT_TRANSACTIONS: usize = 64;
const MAX_HOT_BYTES: usize = 8 * 1024 * 1024;
const MAX_RECORD_BYTES: usize = 128 * 1024 * 1024;

/// Only this bounded cache owns complete trees in memory. The immutable archive
/// remains the source of truth for every transaction ID, including evicted IDs.
#[derive(Default)]
pub(super) struct TransactionCache {
    entries: BTreeMap<String, (TransactionRecord, usize)>,
    order: VecDeque<String>,
    bytes: usize,
}

impl TransactionCache {
    fn get(&mut self, id: &str) -> Option<TransactionRecord> {
        let record = self.entries.get(id)?.0.clone();
        self.order.retain(|entry| entry != id);
        self.order.push_back(id.into());
        Some(record)
    }

    fn insert(&mut self, record: TransactionRecord, bytes: usize) {
        if bytes > MAX_HOT_BYTES {
            return;
        }
        let id = record.receipt.transaction_id.clone();
        if self.entries.contains_key(&id) {
            return;
        }
        while self.entries.len() >= MAX_HOT_TRANSACTIONS
            || self.bytes.saturating_add(bytes) > MAX_HOT_BYTES
        {
            if let Some(oldest) = self.order.pop_front() {
                if let Some((_, size)) = self.entries.remove(&oldest) {
                    self.bytes -= size;
                }
            } else {
                break;
            }
        }
        self.bytes += bytes;
        self.order.push_back(id.clone());
        self.entries.insert(id, (record, bytes));
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(rename_all = "camelCase")]
pub enum FileTransactionStatus {
    Committed,
    Rejected,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq, TS)]
pub struct FileTransactionError {
    pub code: String,
    pub message: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(rename_all = "camelCase")]
pub struct FileTransactionReceipt {
    pub transaction_id: String,
    pub status: FileTransactionStatus,
    pub tree: Option<ProjectFileTree>,
    pub error: Option<FileTransactionError>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct TransactionRecord {
    subject_id: String,
    request_digest: String,
    pub(super) receipt: FileTransactionReceipt,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct CommitJournal {
    pub(super) committed: bool,
    pub(super) transaction: TransactionRecord,
    pub(super) undo: BTreeMap<String, UndoEntry>,
}

fn transaction_id_ok(id: &str) -> Result<()> {
    require(
        !id.is_empty()
            && id.len() <= 128
            && id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_'),
        "invalid",
        "事务编号须为 1 至 128 位字母、数字、短横线或下划线",
    )
}

impl TransactionRecord {
    fn validate(&self) -> Result<()> {
        transaction_id_ok(&self.receipt.transaction_id)
            .map_err(|_| Error::new("storage", "持久事务编号无效"))?;
        require(
            !self.subject_id.is_empty()
                && self.request_digest.len() == 64
                && self.request_digest.bytes().all(|b| b.is_ascii_hexdigit()),
            "storage",
            "事务身份或请求摘要无效",
        )?;
        require(
            match self.receipt.status {
                FileTransactionStatus::Committed => {
                    self.receipt.tree.is_some() && self.receipt.error.is_none()
                }
                FileTransactionStatus::Rejected => {
                    self.receipt.tree.is_none()
                        && self
                            .receipt
                            .error
                            .as_ref()
                            .is_some_and(|e| !e.code.is_empty())
                }
            },
            "storage",
            "事务记录结果无效",
        )
    }

    fn new(subject: &str, id: &str, changes: &[FileChange]) -> Result<Self> {
        // JSON member order and lease renewal cannot change the identity of a retry.
        // Operation order, expected versions, destinations and exact payloads do matter.
        let canonical = changes
            .iter()
            .map(|c| {
                (
                    &c.op,
                    &c.path,
                    &c.version,
                    &c.content,
                    &c.destination,
                    &c.destination_version,
                )
            })
            .collect::<Vec<_>>();
        Ok(Self {
            subject_id: subject.into(),
            request_digest: hex_digest(
                &serde_json::to_vec(&canonical)
                    .map_err(|_| Error::new("invalid", "事务请求编码失败"))?,
            ),
            receipt: FileTransactionReceipt {
                transaction_id: id.into(),
                status: FileTransactionStatus::Committed,
                tree: None,
                error: None,
            },
        })
    }

    fn reject(&mut self, error: &Error) {
        self.receipt.status = FileTransactionStatus::Rejected;
        self.receipt.tree = None;
        self.receipt.error = Some(FileTransactionError {
            code: error.code.into(),
            message: error.message.clone(),
        });
    }
}

impl ProjectFiles {
    fn transaction_directory(&self) -> PathBuf {
        self.root.join(".hanshu/service/file-transactions")
    }

    fn archive_directory(&self) -> PathBuf {
        self.transaction_directory().join("archive")
    }

    fn transaction_path(&self, id: &str) -> PathBuf {
        // Hashing prevents case-insensitive filesystems from aliasing distinct IDs;
        // sharding avoids an ever-growing single directory. No ID ever expires.
        let hash = hex_digest(id.as_bytes());
        self.archive_directory()
            .join(&hash[..2])
            .join(format!("{hash}.json.gz"))
    }

    fn checked_directory(path: &Path, create: bool) -> Result<()> {
        match fs::symlink_metadata(path) {
            Ok(meta) => require(
                meta.is_dir() && !reparse(&meta),
                "storage",
                "事务记录目录无效或为链接",
            ),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound && create => {
                fs::create_dir(path)?;
                Ok(())
            }
            Err(error) => Err(error.into()),
        }
    }

    fn checked_archive(&self) -> Result<()> {
        Self::checked_directory(&self.transaction_directory(), false)?;
        Self::checked_directory(&self.archive_directory(), false)
    }

    fn decode_record(bytes: &[u8]) -> Result<TransactionRecord> {
        require(
            bytes.len() <= MAX_RECORD_BYTES,
            "storage",
            "事务回执超过单条大小限制",
        )?;
        let record: TransactionRecord = serde_json::from_slice(bytes)
            .map_err(|_| Error::new("storage", "事务记录损坏，拒绝使用"))?;
        record.validate()?;
        Ok(record)
    }

    fn read_archive(&self, path: &Path) -> Result<(TransactionRecord, usize)> {
        let meta = fs::symlink_metadata(path)?;
        require(
            meta.is_file()
                && !reparse(&meta)
                && meta.len() <= (MAX_RECORD_BYTES + 1024 * 1024) as u64,
            "storage",
            "事务归档无效、过大或为链接",
        )?;
        let mut bytes = Vec::new();
        GzDecoder::new(fs::File::open(path)?)
            .take((MAX_RECORD_BYTES + 1) as u64)
            .read_to_end(&mut bytes)
            .map_err(|_| Error::new("storage", "事务归档损坏，拒绝使用"))?;
        let record = Self::decode_record(&bytes)?;
        require(
            path == self.transaction_path(&record.receipt.transaction_id),
            "storage",
            "事务记录名称无效",
        )?;
        Ok((record, bytes.len()))
    }

    fn transaction(&self, id: &str) -> Result<Option<TransactionRecord>> {
        if let Some(record) = self.transactions.borrow_mut().get(id) {
            return Ok(Some(record));
        }
        self.checked_archive()?;
        let path = self.transaction_path(id);
        match fs::symlink_metadata(path.parent().unwrap()) {
            Ok(_) => Self::checked_directory(path.parent().unwrap(), false)?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error.into()),
        }
        match fs::symlink_metadata(&path) {
            Ok(_) => {
                let (record, bytes) = self.read_archive(&path)?;
                self.transactions.borrow_mut().insert(record.clone(), bytes);
                Ok(Some(record))
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(error.into()),
        }
    }

    pub(super) fn load_transactions(&mut self) -> Result<()> {
        let directory = self.transaction_directory();
        Self::checked_directory(&directory, true)?;
        Self::checked_directory(&self.archive_directory(), true)?;
        // Upgrade old receipts one at a time. Publish and verify the immutable
        // archive before deleting its old copy. A crash can safely leave both.
        for entry in fs::read_dir(&directory)? {
            let path = entry?.path();
            let meta = fs::symlink_metadata(&path)?;
            require(!reparse(&meta), "storage", "事务记录不能是链接")?;
            if path.extension().and_then(|s| s.to_str()) != Some("json") {
                continue;
            }
            require(
                meta.is_file() && meta.len() <= MAX_RECORD_BYTES as u64,
                "storage",
                "事务回执超过单条大小限制或类型无效",
            )?;
            let record = Self::decode_record(&fs::read(&path)?)?;
            require(
                path == directory.join(format!(
                    "{}.json",
                    hex_digest(record.receipt.transaction_id.as_bytes())
                )),
                "storage",
                "事务记录名称无效",
            )?;
            self.persist_record(&record)?;
            let (archived, _) =
                self.read_archive(&self.transaction_path(&record.receipt.transaction_id))?;
            Self::same_record(&record, &archived)?;
            fs::remove_file(path)?;
        }
        // Scan one archive at a time to validate storage and recover the greatest
        // revision. Startup I/O grows with history, but live memory stays bounded.
        for shard in fs::read_dir(self.archive_directory())? {
            let shard = shard?.path();
            Self::checked_directory(&shard, false)?;
            require(
                shard
                    .file_name()
                    .and_then(|n| n.to_str())
                    .is_some_and(|name| {
                        name.len() == 2
                            && name
                                .bytes()
                                .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
                    }),
                "storage",
                "事务归档分片名称无效",
            )?;
            for entry in fs::read_dir(shard)? {
                let path = entry?.path();
                let (record, bytes) = self.read_archive(&path)?;
                self.revision = self
                    .revision
                    .max(record.receipt.tree.as_ref().map_or(1, |t| t.revision));
                self.transactions.borrow_mut().insert(record, bytes);
            }
        }
        Ok(())
    }

    fn same_record(a: &TransactionRecord, b: &TransactionRecord) -> Result<()> {
        require(
            a.subject_id == b.subject_id
                && a.request_digest == b.request_digest
                && a.receipt == b.receipt,
            "storage",
            "持久事务回执不一致，拒绝覆盖",
        )
    }

    fn record_bytes(&self, record: &TransactionRecord) -> Result<Vec<u8>> {
        let bytes =
            serde_json::to_vec(record).map_err(|_| Error::new("storage", "事务结果编码失败"))?;
        require(
            bytes.len() <= MAX_RECORD_BYTES,
            "invalid",
            "单条事务回执超过 128 MiB，修改未提交",
        )?;
        Ok(bytes)
    }

    fn persist_record(&mut self, record: &TransactionRecord) -> Result<()> {
        record.validate()?;
        if let Some(existing) = self.transaction(&record.receipt.transaction_id)? {
            return Self::same_record(&existing, record);
        }
        let bytes = self.record_bytes(record)?;
        let mut encoder = GzEncoder::new(Vec::new(), Compression::fast());
        encoder.write_all(&bytes)?;
        let compressed = encoder.finish()?;
        let path = self.transaction_path(&record.receipt.transaction_id);
        self.checked_archive()?;
        Self::checked_directory(path.parent().unwrap(), true)?;
        self.atomic(&path, &compressed)?;
        self.revision = self
            .revision
            .max(record.receipt.tree.as_ref().map_or(1, |t| t.revision));
        self.transactions
            .borrow_mut()
            .insert(record.clone(), bytes.len());
        Ok(())
    }

    fn undo_values(journal: &CommitJournal) -> Result<BTreeMap<String, Option<Option<Vec<u8>>>>> {
        journal
            .undo
            .iter()
            .map(|(path, entry)| {
                path_ok(path)?;
                let value = match entry.kind.as_str() {
                    "missing" => None,
                    "directory" => Some(None),
                    "file" => Some(Some(
                        STANDARD
                            .decode(entry.content.as_deref().unwrap_or_default())
                            .map_err(|_| Error::new("storage", "事务恢复内容无效"))?,
                    )),
                    _ => return Err(Error::new("storage", "事务恢复类型无效")),
                };
                Ok((path.clone(), value))
            })
            .collect()
    }

    fn write_journal(&self, journal: &CommitJournal) -> Result<()> {
        self.atomic(
            &self.journal(),
            &serde_json::to_vec(journal).map_err(|_| Error::new("storage", "事务日志编码失败"))?,
        )
    }

    pub(super) fn recover_transaction(&mut self) -> Result<()> {
        if !self.journal().exists() {
            return Ok(());
        }
        let mut journal: CommitJournal = serde_json::from_slice(&fs::read(self.journal())?)
            .map_err(|_| Error::new("storage", "事务恢复日志损坏，拒绝启动"))?;
        journal.transaction.validate()?;
        require(
            journal.transaction.receipt.status == FileTransactionStatus::Committed,
            "storage",
            "事务恢复日志缺少有效提交决议",
        )?;
        if let Some(existing) = self.transaction(&journal.transaction.receipt.transaction_id)? {
            require(
                existing.subject_id == journal.transaction.subject_id
                    && existing.request_digest == journal.transaction.request_digest,
                "storage",
                "事务日志与回执身份不一致",
            )?;
            // A prepared journal cannot coexist with a committed receipt. Check
            // before applying undo so corrupt metadata cannot roll back a save.
            if !journal.committed {
                require(
                    existing.receipt.status == FileTransactionStatus::Rejected,
                    "storage",
                    "事务决议与回执矛盾",
                )?;
            }
        }
        if !journal.committed {
            self.apply(&Self::undo_values(&journal)?)?;
            // A rejection may have been persisted just before journal removal failed.
            if let Some(record) = self.transaction(&journal.transaction.receipt.transaction_id)? {
                require(
                    record.receipt.status == FileTransactionStatus::Rejected,
                    "storage",
                    "事务决议与回执矛盾",
                )?;
                journal.transaction = record;
            } else {
                journal.transaction.reject(&Error::new(
                    "interrupted",
                    "服务在确认提交前中断，修改已回滚；可重新提交",
                ));
            }
        }
        self.persist_record(&journal.transaction)?;
        fs::remove_file(self.journal())?;
        Ok(())
    }

    pub(super) fn execute_transaction(
        &mut self,
        mut journal: CommitJournal,
        writes: &BTreeMap<String, Option<Option<Vec<u8>>>>,
    ) -> Result<FileTransactionReceipt> {
        // Reject an oversized individual receipt before the journal or files are
        // changed. History count and aggregate archive size are not write limits.
        self.record_bytes(&journal.transaction)?;
        self.write_journal(&journal)?;
        if let Err(error) = self.apply(writes) {
            if self.apply(&Self::undo_values(&journal)?).is_err() {
                self.healthy = false;
                return Err(Error::new(
                    "storage",
                    "事务结果待恢复，请重启服务后查询事务编号",
                ));
            }
            journal.transaction.reject(&error);
            if self.persist_record(&journal.transaction).is_err()
                || fs::remove_file(self.journal()).is_err()
            {
                self.healthy = false;
                return Err(Error::new(
                    "storage",
                    "事务回执待恢复，请重启服务后查询事务编号",
                ));
            }
            return Ok(journal.transaction.receipt);
        }
        // This durable decision is the commit point. Recovery after it only publishes
        // the original receipt, including its exact versions, and never replays a move/delete.
        journal.committed = true;
        if self.write_journal(&journal).is_err()
            || self.persist_record(&journal.transaction).is_err()
            || fs::remove_file(self.journal()).is_err()
        {
            self.healthy = false;
            return Err(Error::new(
                "storage",
                "事务结果待确认，请重启服务后查询事务编号",
            ));
        }
        Ok(journal.transaction.receipt)
    }
}

impl Engine {
    pub fn file_transaction(
        &self,
        sid: &str,
        transaction_id: &str,
    ) -> Result<FileTransactionReceipt> {
        self.role(sid)?;
        transaction_id_ok(transaction_id)?;
        let files = self
            .files
            .as_ref()
            .ok_or_else(|| Error::new("invalid", "未打开目录工程"))?;
        if let Some(record) = files.transaction(transaction_id)? {
            require(
                record.subject_id == self.sessions[sid].0.subject_id,
                "forbidden",
                "不能查询其他主体的事务",
            )?;
            return Ok(record.receipt.clone());
        }
        require(files.healthy, "storage", "事务结果待恢复，请重启服务后查询")?;
        Err(Error::new("not_found", "没有此事务回执"))
    }

    pub fn commit_files(
        &mut self,
        sid: &str,
        transaction_id: &str,
        changes: Vec<FileChange>,
        now: u64,
    ) -> Result<FileTransactionReceipt> {
        self.expire(now);
        self.role(sid)?;
        transaction_id_ok(transaction_id)?;
        let mut record =
            TransactionRecord::new(&self.sessions[sid].0.subject_id, transaction_id, &changes)?;
        let store = self
            .files
            .as_ref()
            .ok_or_else(|| Error::new("invalid", "未打开目录工程"))?;
        if let Some(previous) = store.transaction(transaction_id)? {
            require(
                previous.subject_id == record.subject_id,
                "forbidden",
                "事务编号属于其他主体",
            )?;
            require(
                previous.request_digest == record.request_digest,
                "conflict",
                "事务编号已用于不同的修改内容",
            )?;
            return Ok(previous.receipt.clone());
        }
        require(
            store.healthy && !store.journal().exists(),
            "storage",
            "事务结果待恢复，请重启服务后查询",
        )?;
        let result = self
            .validate_file_changes(sid, &changes, now)
            .and_then(|_| {
                self.files
                    .as_mut()
                    .unwrap()
                    .commit(&changes, record.clone())
            });
        match result {
            Ok(receipt) => Ok(receipt),
            Err(error) => {
                let store = self.files.as_mut().unwrap();
                // An unresolved journal must be recovered before calling an attempt rejected.
                if !store.healthy || store.journal().exists() {
                    return Err(error);
                }
                record.reject(&error);
                store.persist_record(&record)?;
                Ok(record.receipt)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rejected(id: &str) -> TransactionRecord {
        let mut record = TransactionRecord::new("subject", id, &[]).unwrap();
        record.reject(&Error::new("invalid", "test"));
        record
    }

    #[test]
    fn hot_cache_has_a_count_limit_and_keeps_recently_queried_receipts() {
        let mut cache = TransactionCache::default();
        for index in 0..MAX_HOT_TRANSACTIONS {
            cache.insert(rejected(&format!("entry-{index}")), 100);
        }
        assert!(cache.get("entry-0").is_some());
        cache.insert(rejected("next"), 100);
        assert_eq!(cache.entries.len(), MAX_HOT_TRANSACTIONS);
        assert!(cache.get("entry-0").is_some());
        assert!(cache.get("entry-1").is_none());
        assert!(cache.get("next").is_some());
    }

    #[test]
    fn hot_cache_has_a_byte_budget_and_oversized_receipts_remain_disk_only() {
        let mut cache = TransactionCache::default();
        cache.insert(rejected("older"), MAX_HOT_BYTES);
        cache.insert(rejected("newer"), 1);
        assert_eq!(cache.bytes, 1);
        assert!(cache.get("older").is_none());
        cache.insert(rejected("large"), MAX_HOT_BYTES + 1);
        assert!(cache.get("large").is_none());
        assert_eq!(cache.entries.len(), 1);
        assert_eq!(cache.bytes, 1);
    }
}
