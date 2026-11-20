-- The court code of a general court's decision as its own column, for justice_search's court_codes.
-- 0021 read it out of the ECLI at query time; 4 211 decisions (11/2026) have no ECLI, an empty one
-- or one that is not an ECLI at all (mostly the Prague obvodní soudy and the ministry's insolvency
-- register, "(nezadán)"), and the filter never found them. court_code is the ECLI's code where
-- that is a code the courts use (the list below = JUSTICE_COURT_CODES), else the code the court's
-- NAME carries in every other decision (mirror.justice_court_name, read off the mirror itself:
-- names whose decisions agree on one code in ≥ 95 %). A pobočka shares its court's code, as in
-- the ECLI. Filled by a trigger, so the crawler writes nothing new.
CREATE TABLE IF NOT EXISTS mirror.justice_court_name (
  name text PRIMARY KEY,
  code text NOT NULL
);
INSERT INTO mirror.justice_court_name (name, code) VALUES
  ('Krajský soud v Brně', 'KSBR'),
  ('Krajský soud v Brně, pobočka Jihlava', 'KSBR'),
  ('Krajský soud v Hradci Králové', 'KSHK'),
  ('Krajský soud v Hradci Králové, pobočka Pardubice', 'KSHK'),
  ('Krajský soud v Ostravě', 'KSOS'),
  ('Krajský soud v Ostravě, pobočka Olomouc', 'KSOS'),
  ('Krajský soud v Plzni', 'KSPL'),
  ('Krajský soud v Praze', 'KSPH'),
  ('Krajský soud v Ústí nad Labem', 'KSUL'),
  ('Krajský soud v Ústí nad Labem, pobočka Liberec', 'KSUL'),
  ('Krajský soud v Českých Budějovicích', 'KSCB'),
  ('Krajský soud v Českých Budějovicích, pobočka v Táboře', 'KSCB'),
  ('Městský soud v Brně', 'MSBR'),
  ('Městský soud v Praze', 'MSPH'),
  ('Nejvyšší soud', 'NS'),
  ('Obvodní soud pro Prahu 1', 'OSPH01'),
  ('Obvodní soud pro Prahu 10', 'OSPH10'),
  ('Obvodní soud pro Prahu 2', 'OSPH02'),
  ('Obvodní soud pro Prahu 3', 'OSPH03'),
  ('Obvodní soud pro Prahu 4', 'OSPH04'),
  ('Obvodní soud pro Prahu 5', 'OSPH05'),
  ('Obvodní soud pro Prahu 6', 'OSPH06'),
  ('Obvodní soud pro Prahu 7', 'OSPH07'),
  ('Obvodní soud pro Prahu 8', 'OSPH08'),
  ('Obvodní soud pro Prahu 9', 'OSPH09'),
  ('Okresní soud Brno-Venkov', 'OSBI'),
  ('Okresní soud Plzeň-jih', 'OSPJ'),
  ('Okresní soud Plzeň-město', 'OSPM'),
  ('Okresní soud Plzeň-sever', 'OSPS'),
  ('Okresní soud Praha-východ', 'OSPY'),
  ('Okresní soud Praha-západ', 'OSPZ'),
  ('Okresní soud v Benešově', 'OSBN'),
  ('Okresní soud v Berouně', 'OSBR'),
  ('Okresní soud v Blansku', 'OSBK'),
  ('Okresní soud v Bruntále', 'OSBU'),
  ('Okresní soud v Bruntále, pobočka Krnov', 'OSBUKR'),
  ('Okresní soud v Břeclavi', 'OSBV'),
  ('Okresní soud v Chebu', 'OSCH'),
  ('Okresní soud v Chomutově', 'OSCV'),
  ('Okresní soud v Chrudimi', 'OSCR'),
  ('Okresní soud v Domažlicích', 'OSDO'),
  ('Okresní soud v Děčíně', 'OSDC'),
  ('Okresní soud v Havlíčkově Brodě', 'OSHB'),
  ('Okresní soud v Hodoníně', 'OSHO'),
  ('Okresní soud v Hradci Králové', 'OSHK'),
  ('Okresní soud v Jablonci nad Nisou', 'OSJN'),
  ('Okresní soud v Jeseníku', 'OSJE'),
  ('Okresní soud v Jihlavě', 'OSJI'),
  ('Okresní soud v Jindřichově Hradci', 'OSJH'),
  ('Okresní soud v Jičíně', 'OSJC'),
  ('Okresní soud v Karlových Varech', 'OSKV'),
  ('Okresní soud v Karviné', 'OSKI'),
  ('Okresní soud v Karviné, pobočka Havířov', 'OSKIHA'),
  ('Okresní soud v Kladně', 'OSKD'),
  ('Okresní soud v Klatovech', 'OSKT'),
  ('Okresní soud v Kolíně', 'OSKO'),
  ('Okresní soud v Kroměříži', 'OSKM'),
  ('Okresní soud v Kutné Hoře', 'OSKH'),
  ('Okresní soud v Liberci', 'OSLI'),
  ('Okresní soud v Litoměřicích', 'OSLT'),
  ('Okresní soud v Lounech', 'OSLN'),
  ('Okresní soud v Mladé Boleslavi', 'OSMB'),
  ('Okresní soud v Mostě', 'OSMO'),
  ('Okresní soud v Mělníku', 'OSME'),
  ('Okresní soud v Novém Jičíně', 'OSNJ'),
  ('Okresní soud v Nymburce', 'OSNB'),
  ('Okresní soud v Náchodě', 'OSNA'),
  ('Okresní soud v Olomouci', 'OSOL'),
  ('Okresní soud v Opavě', 'OSOP'),
  ('Okresní soud v Ostravě', 'OSOV'),
  ('Okresní soud v Pardubicích', 'OSPU'),
  ('Okresní soud v Pelhřimově', 'OSPE'),
  ('Okresní soud v Prachaticích', 'OSPT'),
  ('Okresní soud v Prostějově', 'OSPV'),
  ('Okresní soud v Písku', 'OSPI'),
  ('Okresní soud v Přerově', 'OSPR'),
  ('Okresní soud v Příbrami', 'OSPB'),
  ('Okresní soud v Rakovníku', 'OSRA'),
  ('Okresní soud v Rokycanech', 'OSRO'),
  ('Okresní soud v Rychnově nad Kněžnou', 'OSRK'),
  ('Okresní soud v Semilech', 'OSSM'),
  ('Okresní soud v Sokolově', 'OSSO'),
  ('Okresní soud v Tachově', 'OSTC'),
  ('Okresní soud v Teplicích', 'OSTP'),
  ('Okresní soud v Trutnově', 'OSTU'),
  ('Okresní soud v Táboře', 'OSTA'),
  ('Okresní soud v Třebíči', 'OSTR'),
  ('Okresní soud v Uherském Hradišti', 'OSUH'),
  ('Okresní soud v Ústí nad Labem', 'OSUL'),
  ('Okresní soud v Ústí nad Orlicí', 'OSUO'),
  ('Okresní soud v České Lípě', 'OSCL'),
  ('Okresní soud v Českém Krumlově', 'OSCK'),
  ('Okresní soud v Českých Budějovicích', 'OSCB'),
  ('Okresní soud v Šumperku', 'OSSU'),
  ('Okresní soud ve Frýdku-Místku', 'OSFM'),
  ('Okresní soud ve Strakonicích', 'OSST'),
  ('Okresní soud ve Svitavách', 'OSSY'),
  ('Okresní soud ve Vsetíně', 'OSVS'),
  ('Okresní soud ve Vsetíně, pobočka Valašské Meziřičí', 'OSVSVM'),
  ('Okresní soud ve Vyškově', 'OSVY'),
  ('Okresní soud ve Zlíně', 'OSZL'),
  ('Okresní soud ve Znojmě', 'OSZN'),
  ('Okresní soud ve Žďáru nad Sázavou', 'OSZR'),
  ('Vrchní soud v Olomouci', 'VSOL'),
  ('Vrchní soud v Praze', 'VSPH'),
  ('Ústavní soud', 'US')
ON CONFLICT (name) DO UPDATE SET code = EXCLUDED.code;

ALTER TABLE mirror.decision ADD COLUMN IF NOT EXISTS court_code text;

CREATE OR REPLACE FUNCTION mirror.justice_court_code(ecli text, court text) RETURNS text
LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
  SELECT CASE
    WHEN ecli ~ '^ECLI:CZ:[A-Z0-9]+:[0-9]{4}:' AND split_part(ecli, ':', 3) IN ('KSBR', 'KSBRJI', 'KSBRZL', 'KSCB', 'KSCBTA', 'KSHK', 'KSHKPA', 'KSOS', 'KSOSOL', 'KSPH', 'KSPL', 'KSPLKV', 'KSUL', 'KSULLI', 'MSBR', 'MSPH', 'NS', 'NSS', 'OSBI', 'OSBK', 'OSBN', 'OSBR', 'OSBU', 'OSBUKR', 'OSBV', 'OSCB', 'OSCH', 'OSCK', 'OSCL', 'OSCR', 'OSCV', 'OSDC', 'OSDO', 'OSFM', 'OSHB', 'OSHK', 'OSHO', 'OSJC', 'OSJE', 'OSJH', 'OSJI', 'OSJN', 'OSKD', 'OSKH', 'OSKI', 'OSKIHA', 'OSKM', 'OSKO', 'OSKT', 'OSKV', 'OSLI', 'OSLN', 'OSLT', 'OSMB', 'OSME', 'OSMO', 'OSNA', 'OSNB', 'OSNJ', 'OSOL', 'OSOP', 'OSOV', 'OSPB', 'OSPE', 'OSPH01', 'OSPH02', 'OSPH03', 'OSPH04', 'OSPH05', 'OSPH06', 'OSPH07', 'OSPH08', 'OSPH09', 'OSPH10', 'OSPI', 'OSPJ', 'OSPM', 'OSPR', 'OSPS', 'OSPT', 'OSPU', 'OSPV', 'OSPY', 'OSPZ', 'OSRA', 'OSRK', 'OSRO', 'OSSM', 'OSSO', 'OSST', 'OSSU', 'OSSY', 'OSTA', 'OSTC', 'OSTP', 'OSTR', 'OSTU', 'OSUH', 'OSUL', 'OSUO', 'OSVS', 'OSVSVM', 'OSVY', 'OSZL', 'OSZN', 'OSZR', 'US', 'VSOL', 'VSPH')
      THEN split_part(ecli, ':', 3)
    ELSE (SELECT n.code FROM mirror.justice_court_name n WHERE n.name = court)
  END
$$;

CREATE OR REPLACE FUNCTION mirror.decision_set_court_code() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  NEW.court_code := CASE WHEN NEW.source = 'justice' THEN mirror.justice_court_code(NEW.ecli, NEW.court) END;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS decision_court_code ON mirror.decision;
CREATE TRIGGER decision_court_code BEFORE INSERT OR UPDATE OF ecli, court, source ON mirror.decision
  FOR EACH ROW EXECUTE FUNCTION mirror.decision_set_court_code();

UPDATE mirror.decision d SET court_code = mirror.justice_court_code(d.ecli, d.court)
WHERE d.source = 'justice' AND d.court_code IS DISTINCT FROM mirror.justice_court_code(d.ecli, d.court);

CREATE INDEX IF NOT EXISTS decision_court_code ON mirror.decision (court_code, decided_on) WHERE source = 'justice';
DROP INDEX IF EXISTS mirror.decision_justice_court_code;

GRANT SELECT ON mirror.justice_court_name TO mirror_reader, mirror_writer;
