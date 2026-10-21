//! Immutable receipts and the durable commit decision share the file undo journal.
//! A prepared journal rolls back; a committed journal publishes its receipt without replaying writes.
use super::*;

const MAX_TRANSACTIONS: usize = 1024;
const MAX_TRANSACTION_BYTES: usize = 128 * 1024 * 1024;

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

    fn transaction_path(&self, id: &str) -> PathBuf {
        // Hashing prevents case-insensitive filesystems from aliasing distinct IDs.
        self.transaction_directory()
            .join(format!("{}.json", hex_digest(id.as_bytes())))
    }

    pub(super) fn load_transactions(&mut self) -> Result<()> {
        let directory = self.transaction_directory();
        if let Ok(meta) = fs::symlink_metadata(&directory) {
            require(!reparse(&meta), "storage", "事务记录目录不能是链接")?;
        }
        fs::create_dir_all(&directory)?;
        for entry in fs::read_dir(directory)? {
            let path = entry?.path();
            require(
                !reparse(&fs::symlink_metadata(&path)?),
                "storage",
                "事务记录不能是链接",
            )?;
            if path.extension().and_then(|s| s.to_str()) != Some("json") {
                continue; // A process crash may leave an unpersisted tempfile.
            }
            let bytes = fs::read(&path)?;
            let record: TransactionRecord = serde_json::from_slice(&bytes)
                .map_err(|_| Error::new("storage", "事务记录损坏，拒绝启动"))?;
            record.validate()?;
            require(
                path == self.transaction_path(&record.receipt.transaction_id),
                "storage",
                "事务记录名称无效",
            )?;
            self.revision = self
                .revision
                .max(record.receipt.tree.as_ref().map_or(1, |t| t.revision));
            self.transaction_bytes += bytes.len();
            self.transactions
                .insert(record.receipt.transaction_id.clone(), record);
        }
        Ok(())
    }

    fn capacity(&self, bytes: usize) -> Result<()> {
        require(
            self.transactions.len() < MAX_TRANSACTIONS
                && self.transaction_bytes.saturating_add(bytes) <= MAX_TRANSACTION_BYTES,
            "busy",
            "事务回执已达容量上限，服务拒绝新提交；已有回执仍可查询",
        )
    }

    fn record_bytes(&self, record: &TransactionRecord) -> Result<Vec<u8>> {
        serde_json::to_vec(record).map_err(|_| Error::new("storage", "事务结果编码失败"))
    }

    fn persist_record(&mut self, record: &TransactionRecord) -> Result<()> {
        record.validate()?;
        if let Some(existing) = self.transactions.get(&record.receipt.transaction_id) {
            require(
                existing.subject_id == record.subject_id
                    && existing.request_digest == record.request_digest
                    && existing.receipt == record.receipt,
                "storage",
                "持久事务回执不一致，拒绝覆盖",
            )?;
            return Ok(());
        }
        let bytes = self.record_bytes(record)?;
        self.atomic(
            &self.transaction_path(&record.receipt.transaction_id),
            &bytes,
        )?;
        self.transaction_bytes += bytes.len();
        self.revision = self
            .revision
            .max(record.receipt.tree.as_ref().map_or(1, |t| t.revision));
        self.transactions
            .insert(record.receipt.transaction_id.clone(), record.clone());
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
        if let Some(existing) = self
            .transactions
            .get(&journal.transaction.receipt.transaction_id)
        {
            require(
                existing.subject_id == journal.transaction.subject_id
                    && existing.request_digest == journal.transaction.request_digest,
                "storage",
                "事务日志与回执身份不一致",
            )?;
        }
        if !journal.committed {
            self.apply(&Self::undo_values(&journal)?)?;
            // A rejection may have been persisted just before journal removal failed.
            if let Some(record) = self
                .transactions
                .get(&journal.transaction.receipt.transaction_id)
            {
                require(
                    record.receipt.status == FileTransactionStatus::Rejected,
                    "storage",
                    "事务决议与回执矛盾",
                )?;
                journal.transaction = record.clone();
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
        self.capacity(self.record_bytes(&journal.transaction)?.len())?;
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
        if let Some(record) = files.transactions.get(transaction_id) {
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
        if let Some(previous) = store.transactions.get(transaction_id) {
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
        store.capacity(0)?;
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
                store.capacity(store.record_bytes(&record)?.len())?;
                store.persist_record(&record)?;
                Ok(record.receipt)
            }
        }
    }
}
