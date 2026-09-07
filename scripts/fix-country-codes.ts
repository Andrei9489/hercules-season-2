// Repară coloana country pentru live_tv: nume RO → cod ISO (după primul import)
// Rulează: bun scripts/fix-country-codes.ts
import { neonConfig, Pool } from "@neondatabase/serverless";
import WebSocket from "ws";

neonConfig.webSocketConstructor = WebSocket;
const url =
  (process.env.NEON_DATABASE_URL || "").startsWith("postgres")
    ? process.env.NEON_DATABASE_URL
    : "postgresql://neondb_owner:npg_k8zGXZEKr5xV@ep-sparkling-leaf-b2wkkjbz-pooler.c-6.eu-central-1.aws.neon.tech/neondb?sslmode=require";

const pool = new Pool({ connectionString: url, max: 4 });

// [cod, nume RO] — aceeași hartă ca în import
const MAP: [string, string][] = [
  ["au", "Australia"], ["nz", "Noua Zeelandă"], ["fj", "Fiji"],
  ["es", "Spania"], ["pt", "Portugalia"], ["fr", "Franța"],
  ["it", "Italia"], ["gr", "Grecia"], ["ro", "România"],
  ["md", "Moldova"], ["bg", "Bulgaria"], ["hu", "Ungaria"],
  ["al", "Albania"], ["xk", "Kosovo"], ["mk", "Macedonia de Nord"],
  ["rs", "Serbia"], ["hr", "Croația"], ["ba", "Bosnia și Herțegovina"],
  ["si", "Slovenia"], ["sk", "Slovacia"], ["cz", "Cehia"],
  ["pl", "Polonia"], ["de", "Germania"], ["at", "Austria"],
  ["ch", "Elveția"], ["nl", "Olanda"], ["be", "Belgia"],
  ["uk", "Regatul Unit"], ["ie", "Irlanda"], ["is", "Islanda"],
  ["se", "Suedia"], ["fi", "Finlanda"], ["dk", "Danemarca"],
  ["no", "Norvegia"], ["lt", "Lituania"], ["lv", "Letonia"],
  ["ee", "Estonia"], ["mt", "Malta"], ["cy", "Cipru"],
  ["mc", "Monaco"], ["ua", "Ucraina"], ["by", "Belarus"],
  ["ru", "Rusia"], ["tr", "Turcia"], ["am", "Armenia"],
  ["ge", "Georgia"], ["az", "Azerbaidjan"],
  ["us", "Statele Unite"], ["ca", "Canada"],
  ["mx", "Mexic"], ["gt", "Guatemala"],
  ["hn", "Honduras"], ["sv", "El Salvador"],
  ["ni", "Nicaragua"], ["cr", "Costa Rica"],
  ["pa", "Panama"], ["bz", "Belize"],
  ["cu", "Cuba"], ["ht", "Haiti"],
  ["do", "Republica Dominicană"], ["pr", "Puerto Rico"],
  ["jm", "Jamaica"], ["bs", "Bahamas"],
  ["co", "Colombia"], ["ve", "Venezuela"],
  ["ec", "Ecuador"], ["pe", "Peru"],
  ["bo", "Bolivia"], ["br", "Brazilia"],
  ["py", "Paraguay"], ["cl", "Chile"],
  ["ar", "Argentina"], ["uy", "Uruguay"],
  ["cn", "China"], ["hk", "Hong Kong"], ["tw", "Taiwan"],
  ["mo", "Macao"], ["jp", "Japonia"], ["kr", "Coreea de Sud"],
  ["kp", "Coreea de Nord"], ["mn", "Mongolia"], ["th", "Thailanda"],
  ["vn", "Vietnam"], ["ph", "Filipine"], ["id", "Indonezia"],
  ["my", "Malaysia"], ["sg", "Singapore"], ["mm", "Myanmar"],
  ["bd", "Bangladesh"], ["in", "India"], ["pk", "Pakistan"],
  ["lk", "Sri Lanka"], ["np", "Nepal"], ["mv", "Maldive"],
  ["af", "Afganistan"], ["kz", "Kazahstan"], ["uz", "Uzbekistan"],
  ["kg", "Kârgâzstan"], ["tj", "Tadjikistan"], ["ir", "Iran"],
  ["iq", "Irak"], ["sa", "Arabia Saudită"], ["ae", "Emiratele Arabe Unite"],
  ["qa", "Qatar"], ["kw", "Kuweit"], ["om", "Oman"],
  ["bh", "Bahrain"], ["ye", "Yemen"], ["jo", "Iordania"],
  ["lb", "Liban"], ["sy", "Siria"], ["ps", "Palestina"],
  ["il", "Israel"], ["la", "Laos"], ["kh", "Cambodgia"],
  ["ma", "Maroc"], ["dz", "Algeria"], ["tn", "Tunisia"],
  ["ly", "Libia"], ["eg", "Egipt"], ["sd", "Sudan"],
  ["et", "Etiopia"], ["ke", "Kenya"], ["ug", "Uganda"],
  ["tz", "Tanzania"], ["ng", "Nigeria"], ["gh", "Ghana"],
  ["sn", "Senegal"], ["cm", "Camerun"], ["ci", "Coasta de Fildeș"],
  ["bf", "Burkina Faso"], ["ne", "Niger"], ["ml", "Mali"],
  ["gn", "Guinea"], ["bj", "Benin"], ["tg", "Togo"],
  ["cd", "RD Congo"], ["cg", "Congo"], ["za", "Africa de Sud"],
  ["na", "Namibia"], ["zw", "Zimbabwe"], ["zm", "Zambia"],
  ["ao", "Angola"], ["mz", "Mozambic"], ["mg", "Madagascar"],
  ["mu", "Mauritius"], ["rw", "Rwanda"], ["bi", "Burundi"],
];

let fixed = 0;
for (const [code, name] of MAP) {
  const res = await pool.query(
    `UPDATE content SET country = $1
     WHERE content_type = 'live_tv' AND country = $2 AND country <> $1`,
    [code, name]
  );
  fixed += res.rowCount || 0;
}
const missing = await pool.query(
  `SELECT count(*)::int AS n FROM content WHERE content_type='live_tv' AND (country IS NULL OR length(country) <> 2)`
);
console.log(`Reparate: ${fixed} rânduri; rămase fără cod: ${missing.rows[0].n}`);
await pool.end();
