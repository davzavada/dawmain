/* Inserts sample data so the UI has something to show — but only into an
 * empty database, so it can never touch real data. Run: npm run seed */
import { db, migrate, withTransaction } from './db.js';

migrate();

const existing = (db.prepare('SELECT COUNT(*) AS n FROM people').get() as { n: number }).n;
if (existing > 0) {
  console.log(`Database already has ${existing} people — seed skipped.`);
  process.exit(0);
}

function person(name: string, titles: string | null, country: string | null): number {
  return Number(
    db
      .prepare('INSERT INTO people (name, titles, country) VALUES (?,?,?)')
      .run(name, titles, country).lastInsertRowid,
  );
}

function institution(name: string, short: string | null, city: string, country: string): number {
  return Number(
    db
      .prepare('INSERT INTO institutions (name, short_name, city, country) VALUES (?,?,?,?)')
      .run(name, short, city, country).lastInsertRowid,
  );
}

function affiliation(personId: number, institutionId: number, role: string, start: string): void {
  db.prepare(
    'INSERT INTO affiliations (person_id, institution_id, role, start_date) VALUES (?,?,?,?)',
  ).run(personId, institutionId, role, start);
}

function publication(
  title: string,
  year: number,
  venue: string,
  type: string,
  authors: (number | string)[],
): void {
  const pubId = Number(
    db
      .prepare('INSERT INTO publications (title, year, venue, type) VALUES (?,?,?,?)')
      .run(title, year, venue, type).lastInsertRowid,
  );
  authors.forEach((author, index) => {
    if (typeof author === 'number') {
      const name = (db.prepare('SELECT name FROM people WHERE id = ?').get(author) as { name: string }).name;
      db.prepare(
        'INSERT INTO publication_authors (publication_id, position, author_name, person_id) VALUES (?,?,?,?)',
      ).run(pubId, index + 1, name, author);
    } else {
      db.prepare(
        'INSERT INTO publication_authors (publication_id, position, author_name) VALUES (?,?,?)',
      ).run(pubId, index + 1, author);
    }
  });
}

function relation(from: number, to: number, type: string, date: string | null, note: string | null): void {
  db.prepare(
    'INSERT INTO relations (from_person_id, to_person_id, type, date, note) VALUES (?,?,?,?,?)',
  ).run(from, to, type, date, note);
}

function interaction(personId: number, date: string, kind: string, note: string | null): void {
  db.prepare('INSERT INTO interactions (person_id, date, kind, note) VALUES (?,?,?,?)').run(
    personId,
    date,
    kind,
    note,
  );
}

function tag(personId: number, name: string): void {
  db.prepare('INSERT INTO tags (name) VALUES (?) ON CONFLICT(name) DO NOTHING').run(name);
  const t = db.prepare('SELECT id FROM tags WHERE name = ? COLLATE NOCASE').get(name) as { id: number };
  db.prepare('INSERT OR IGNORE INTO person_tags (person_id, tag_id) VALUES (?,?)').run(personId, t.id);
}

withTransaction(() => {
  const pfuk = institution('Univerzita Karlova, Právnická fakulta', 'PF UK', 'Praha', 'CZ');
  const muni = institution('Masarykova univerzita, Právnická fakulta', 'PF MUNI', 'Brno', 'CZ');
  const mpil = institution(
    'Max Planck Institute for Comparative Public Law and International Law',
    'MPIL',
    'Heidelberg',
    'DE',
  );
  const eui = institution('European University Institute', 'EUI', 'Florence', 'IT');

  const jana = person('Jana Svobodová', 'JUDr., Ph.D.', 'CZ');
  const martin = person('Martin Kraus', 'doc. JUDr., Ph.D.', 'CZ');
  const anna = person('Anna Bartošová', 'Mgr.', 'CZ');
  const peter = person('Peter Schneider', 'Prof. Dr.', 'DE');
  const lucia = person('Lucia Hronská', 'JUDr., PhD.', 'SK');
  const marco = person('Marco Rossi', 'Ph.D.', 'IT');

  affiliation(jana, pfuk, 'odborná asistentka', '2021');
  affiliation(martin, muni, 'docent', '2018');
  affiliation(anna, pfuk, 'doktorandka', '2023');
  affiliation(peter, mpil, 'senior research fellow', '2015');
  affiliation(lucia, muni, 'postdoc', '2024');
  affiliation(marco, eui, 'research fellow', '2022');

  tag(jana, 'EU law');
  tag(jana, 'data protection');
  tag(anna, 'data protection');
  tag(peter, 'constitutional law');
  tag(marco, 'potential collaborator');
  tag(lucia, 'potential collaborator');

  publication('Ústavní limity automatizovaného rozhodování', 2024, 'Právník', 'article', [
    jana,
    martin,
    'Ondřej Malý',
  ]);
  publication('Judicial Independence in Central Europe', 2023, 'ICON', 'article', [jana, peter]);
  publication(
    'Data Protection and the Administrative State',
    2025,
    'Cambridge University Press',
    'chapter',
    [anna, jana],
  );

  relation(peter, jana, 'supervisor', '2019', 'research stay in Heidelberg');
  relation(jana, anna, 'colleague', '2023', null);
  relation(jana, marco, 'met_at_conference', '2024', 'ICON-S Madrid');
  relation(martin, jana, 'friend', '2017', null);
  relation(lucia, anna, 'met_at_conference', '2025', 'COFOLA Brno');

  interaction(jana, '2026-06-12', 'conference', 'chaired my panel at ICON-S, discussed AI act paper');
  interaction(jana, '2026-07-30', 'email', 'sent her the draft for comments');
  interaction(marco, '2024-07-08', 'conference', 'dinner after the Madrid panel');
  interaction(peter, '2025-11-02', 'meeting', 'Heidelberg visit, talked postdoc options');

  // mark one paper as a liked/read reference
  db.prepare(
    `UPDATE publications SET starred = 1, read_status = 'read',
     note = 'great framing of judicial independence metrics — cite in ch. 2'
     WHERE title = 'Judicial Independence in Central Europe'`,
  ).run();
});

console.log(
  'Seeded: 6 people, 4 institutions, 3 publications (one starred, one with an unlinked co-author), 5 relations, 4 interactions.',
);
