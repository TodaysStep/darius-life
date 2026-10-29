import sqlite3,tempfile,concurrent.futures,pathlib
sql=pathlib.Path(__file__).with_name('bench-note-identity.sql').read_text()
p=tempfile.mktemp(suffix='.sqlite');db=sqlite3.connect(p)
db.execute('CREATE TABLE docket_entries(id TEXT PRIMARY KEY,created_at TEXT,share_number INTEGER UNIQUE,shared_at TEXT,fact TEXT)')
for i in range(1,7): db.execute('INSERT INTO docket_entries VALUES(?,?,?,?,?)',(str(i),str(i),i if i<4 else None,'shared' if i<4 else None,'private-body'))
db.commit();before=db.execute('SELECT id,shared_at,fact FROM docket_entries ORDER BY id').fetchall();db.executescript(sql);first=db.execute('SELECT * FROM docket_entries ORDER BY id').fetchall();db.executescript(sql);assert first==db.execute('SELECT * FROM docket_entries ORDER BY id').fetchall();assert before==db.execute('SELECT id,shared_at,fact FROM docket_entries ORDER BY id').fetchall();assert [r[2] for r in first]==list(range(1,7))
def insert(i):
 c=sqlite3.connect(p,timeout=15);c.execute('INSERT INTO docket_entries(id,created_at,fact) VALUES(?,?,?)',(str(i),str(i),'private-body'));c.commit();c.close()
with concurrent.futures.ThreadPoolExecutor(max_workers=10) as ex:list(ex.map(insert,range(7,47)))
assert db.execute('SELECT COUNT(*),COUNT(DISTINCT share_number),MAX(share_number) FROM docket_entries').fetchone()==(46,46,46)
db.execute('DELETE FROM docket_entries WHERE share_number=46');db.commit();insert(47);assert db.execute('SELECT share_number,shared_at FROM docket_entries WHERE id="47"').fetchone()==(47,None)
assert db.execute('SELECT COUNT(*) FROM docket_entries WHERE shared_at IS NOT NULL').fetchone()[0]==3
print('PASS: deterministic backfill, idempotency, original numbers/privacy preserved, 40 concurrent inserts unique, deleted number not reused')
