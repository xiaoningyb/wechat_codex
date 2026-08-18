import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export class Store {
  constructor(path) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions (conversation_key TEXT PRIMARY KEY, userid TEXT NOT NULL, project_id TEXT NOT NULL, thread_id TEXT, mode TEXT NOT NULL DEFAULT 'readOnly', active_turn_id TEXT, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS processed_messages (msgid TEXT PRIMARY KEY, processed_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS approvals (task_id TEXT PRIMARY KEY, request_id TEXT NOT NULL, conversation_key TEXT NOT NULL, thread_id TEXT NOT NULL, turn_id TEXT NOT NULL, item_id TEXT NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS turns (turn_id TEXT PRIMARY KEY, conversation_key TEXT NOT NULL, thread_id TEXT NOT NULL, prompt TEXT NOT NULL, status TEXT NOT NULL, started_at INTEGER NOT NULL, completed_at INTEGER, final_text TEXT);
      CREATE TABLE IF NOT EXISTS thread_aliases (conversation_key TEXT NOT NULL, position INTEGER NOT NULL, thread_id TEXT NOT NULL, project_id TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY(conversation_key, position));
      CREATE TABLE IF NOT EXISTS interaction_states (conversation_key TEXT PRIMARY KEY, kind TEXT NOT NULL, payload TEXT NOT NULL, updated_at INTEGER NOT NULL);
    `);
    this.recoverInterruptedWork();
  }
  close() { this.db.close(); }
  getSetting(key) { return this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value || null; }
  setSetting(key, value) { this.db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value); }
  claimOwner(userid) { const owner = this.getSetting('owner_userid'); if (owner) return owner === userid; this.setSetting('owner_userid', userid); return true; }
  hasProcessed(msgid) { return Boolean(this.db.prepare('SELECT 1 FROM processed_messages WHERE msgid=?').get(msgid)); }
  markProcessed(msgid) { this.db.prepare('INSERT OR IGNORE INTO processed_messages(msgid,processed_at) VALUES(?,?)').run(msgid, Date.now()); }
  getSession(key) { return this.db.prepare('SELECT * FROM sessions WHERE conversation_key=?').get(key) || null; }
  upsertSession(session) {
    this.db.prepare(`INSERT INTO sessions(conversation_key,userid,project_id,thread_id,mode,active_turn_id,updated_at) VALUES(@conversation_key,@userid,@project_id,@thread_id,@mode,@active_turn_id,@updated_at)
      ON CONFLICT(conversation_key) DO UPDATE SET userid=excluded.userid,project_id=excluded.project_id,thread_id=excluded.thread_id,mode=excluded.mode,active_turn_id=excluded.active_turn_id,updated_at=excluded.updated_at`).run({ ...session, thread_id: session.thread_id || null, active_turn_id: session.active_turn_id || null, updated_at: Date.now() });
  }
  createTurn({ turnId, conversationKey, threadId, prompt }) { this.db.prepare('INSERT INTO turns(turn_id,conversation_key,thread_id,prompt,status,started_at) VALUES(?,?,?,?,?,?)').run(turnId, conversationKey, threadId, prompt, 'inProgress', Date.now()); }
  completeTurn(turnId, status, finalText = '') { this.db.prepare('UPDATE turns SET status=?,completed_at=?,final_text=? WHERE turn_id=?').run(status, Date.now(), finalText, turnId); }
  getTurn(turnId) { return this.db.prepare('SELECT * FROM turns WHERE turn_id=?').get(turnId) || null; }
  latestTurn(conversationKey) { return this.db.prepare('SELECT * FROM turns WHERE conversation_key=? ORDER BY started_at DESC LIMIT 1').get(conversationKey) || null; }
  pendingApprovalsForTurn(turnId) { return this.db.prepare("SELECT * FROM approvals WHERE turn_id=? AND status='pending' ORDER BY created_at").all(turnId); }
  replaceThreadAliases(conversationKey, entries) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('DELETE FROM thread_aliases WHERE conversation_key=?').run(conversationKey);
      const insert = this.db.prepare('INSERT INTO thread_aliases(conversation_key,position,thread_id,project_id,updated_at) VALUES(?,?,?,?,?)');
      entries.forEach((entry, index) => insert.run(conversationKey, index + 1, entry.threadId, entry.projectId, Date.now()));
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  resolveThreadAlias(conversationKey, position) { return this.db.prepare('SELECT * FROM thread_aliases WHERE conversation_key=? AND position=?').get(conversationKey, position) || null; }
  setInteractionState(conversationKey, kind, payload = {}) {
    this.db.prepare(`INSERT INTO interaction_states(conversation_key,kind,payload,updated_at) VALUES(?,?,?,?)
      ON CONFLICT(conversation_key) DO UPDATE SET kind=excluded.kind,payload=excluded.payload,updated_at=excluded.updated_at`).run(conversationKey, kind, JSON.stringify(payload), Date.now());
  }
  getInteractionState(conversationKey) {
    const row = this.db.prepare('SELECT * FROM interaction_states WHERE conversation_key=?').get(conversationKey);
    if (!row) return null;
    try { return { ...row, payload: JSON.parse(row.payload) }; } catch { return { ...row, payload: {} }; }
  }
  clearInteractionState(conversationKey) { this.db.prepare('DELETE FROM interaction_states WHERE conversation_key=?').run(conversationKey); }
  saveApproval(item) { this.db.prepare(`INSERT INTO approvals(task_id,request_id,conversation_key,thread_id,turn_id,item_id,kind,payload,status,created_at) VALUES(@taskId,@requestId,@conversationKey,@threadId,@turnId,@itemId,@kind,@payload,'pending',@createdAt)`).run({ ...item, createdAt: Date.now() }); }
  getApproval(taskId) { return this.db.prepare('SELECT * FROM approvals WHERE task_id=?').get(taskId) || null; }
  resolveApproval(taskId, status) { this.db.prepare('UPDATE approvals SET status=? WHERE task_id=?').run(status, taskId); }
  pendingInput(conversationKey) { return this.db.prepare("SELECT * FROM approvals WHERE conversation_key=? AND kind='input' AND status='pending' ORDER BY created_at LIMIT 1").get(conversationKey) || null; }
  recoverInterruptedWork() {
    const now = Date.now();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare("UPDATE approvals SET status='expired' WHERE status='pending'").run();
      this.db.prepare("UPDATE turns SET status='interrupted',completed_at=?,final_text=COALESCE(final_text,'服务重启，原任务已中断。') WHERE status='inProgress'").run(now);
      this.db.prepare('UPDATE sessions SET active_turn_id=NULL,updated_at=? WHERE active_turn_id IS NOT NULL').run(now);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
}
