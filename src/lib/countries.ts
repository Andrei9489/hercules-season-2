// Harta țărilor pentru canale TV live — nume RO + continent
export const COUNTRY_INFO: Record<string, [string, string]> = {
  au: ["Australia", "Oceania"], nz: ["Noua Zeelandă", "Oceania"], fj: ["Fiji", "Oceania"],
  es: ["Spania", "Europa"], pt: ["Portugalia", "Europa"], fr: ["Franța", "Europa"],
  it: ["Italia", "Europa"], gr: ["Grecia", "Europa"], ro: ["România", "Europa"],
  md: ["Moldova", "Europa"], bg: ["Bulgaria", "Europa"], hu: ["Ungaria", "Europa"],
  al: ["Albania", "Europa"], xk: ["Kosovo", "Europa"], mk: ["Macedonia de Nord", "Europa"],
  rs: ["Serbia", "Europa"], hr: ["Croația", "Europa"], ba: ["Bosnia și Herțegovina", "Europa"],
  si: ["Slovenia", "Europa"], sk: ["Slovacia", "Europa"], cz: ["Cehia", "Europa"],
  pl: ["Polonia", "Europa"], de: ["Germania", "Europa"], at: ["Austria", "Europa"],
  ch: ["Elveția", "Europa"], nl: ["Olanda", "Europa"], be: ["Belgia", "Europa"],
  uk: ["Regatul Unit", "Europa"], ie: ["Irlanda", "Europa"], is: ["Islanda", "Europa"],
  se: ["Suedia", "Europa"], fi: ["Finlanda", "Europa"], dk: ["Danemarca", "Europa"],
  no: ["Norvegia", "Europa"], lt: ["Lituania", "Europa"], lv: ["Letonia", "Europa"],
  ee: ["Estonia", "Europa"], mt: ["Malta", "Europa"], cy: ["Cipru", "Europa"],
  mc: ["Monaco", "Europa"], ua: ["Ucraina", "Europa"], by: ["Belarus", "Europa"],
  ru: ["Rusia", "Europa"], tr: ["Turcia", "Europa"], am: ["Armenia", "Europa"],
  ge: ["Georgia", "Asia"], az: ["Azerbaidjan", "Asia"],
  us: ["Statele Unite", "America de Nord"], ca: ["Canada", "America de Nord"],
  mx: ["Mexic", "America de Nord"], gt: ["Guatemala", "America de Nord"],
  hn: ["Honduras", "America de Nord"], sv: ["El Salvador", "America de Nord"],
  ni: ["Nicaragua", "America de Nord"], cr: ["Costa Rica", "America de Nord"],
  pa: ["Panama", "America de Nord"], bz: ["Belize", "America de Nord"],
  cu: ["Cuba", "America de Nord"], ht: ["Haiti", "America de Nord"],
  do: ["Republica Dominicană", "America de Nord"], pr: ["Puerto Rico", "America de Nord"],
  jm: ["Jamaica", "America de Nord"], bs: ["Bahamas", "America de Nord"],
  co: ["Colombia", "America de Sud"], ve: ["Venezuela", "America de Sud"],
  ec: ["Ecuador", "America de Sud"], pe: ["Peru", "America de Sud"],
  bo: ["Bolivia", "America de Sud"], br: ["Brazilia", "America de Sud"],
  py: ["Paraguay", "America de Sud"], cl: ["Chile", "America de Sud"],
  ar: ["Argentina", "America de Sud"], uy: ["Uruguay", "America de Sud"],
  cn: ["China", "Asia"], hk: ["Hong Kong", "Asia"], tw: ["Taiwan", "Asia"],
  mo: ["Macao", "Asia"], jp: ["Japonia", "Asia"], kr: ["Coreea de Sud", "Asia"],
  kp: ["Coreea de Nord", "Asia"], mn: ["Mongolia", "Asia"], th: ["Thailanda", "Asia"],
  vn: ["Vietnam", "Asia"], ph: ["Filipine", "Asia"], id: ["Indonezia", "Asia"],
  my: ["Malaysia", "Asia"], sg: ["Singapore", "Asia"], mm: ["Myanmar", "Asia"],
  bd: ["Bangladesh", "Asia"], in: ["India", "Asia"], pk: ["Pakistan", "Asia"],
  lk: ["Sri Lanka", "Asia"], np: ["Nepal", "Asia"], mv: ["Maldive", "Asia"],
  af: ["Afganistan", "Asia"], kz: ["Kazahstan", "Asia"], uz: ["Uzbekistan", "Asia"],
  kg: ["Kârgâzstan", "Asia"], tj: ["Tadjikistan", "Asia"], ir: ["Iran", "Asia"],
  iq: ["Irak", "Asia"], sa: ["Arabia Saudită", "Asia"], ae: ["Emiratele Arabe Unite", "Asia"],
  qa: ["Qatar", "Asia"], kw: ["Kuweit", "Asia"], om: ["Oman", "Asia"],
  bh: ["Bahrain", "Asia"], ye: ["Yemen", "Asia"], jo: ["Iordania", "Asia"],
  lb: ["Liban", "Asia"], sy: ["Siria", "Asia"], ps: ["Palestina", "Asia"],
  il: ["Israel", "Asia"], la: ["Laos", "Asia"], kh: ["Cambodgia", "Asia"],
  ma: ["Maroc", "Africa"], dz: ["Algeria", "Africa"], tn: ["Tunisia", "Africa"],
  ly: ["Libia", "Africa"], eg: ["Egipt", "Africa"], sd: ["Sudan", "Africa"],
  et: ["Etiopia", "Africa"], ke: ["Kenya", "Africa"], ug: ["Uganda", "Africa"],
  tz: ["Tanzania", "Africa"], ng: ["Nigeria", "Africa"], gh: ["Ghana", "Africa"],
  sn: ["Senegal", "Africa"], cm: ["Camerun", "Africa"], ci: ["Coasta de Fildeș", "Africa"],
  bf: ["Burkina Faso", "Africa"], ne: ["Niger", "Africa"], ml: ["Mali", "Africa"],
  gn: ["Guinea", "Africa"], bj: ["Benin", "Africa"], tg: ["Togo", "Africa"],
  cd: ["RD Congo", "Africa"], cg: ["Congo", "Africa"], za: ["Africa de Sud", "Africa"],
  na: ["Namibia", "Africa"], zw: ["Zimbabwe", "Africa"], zm: ["Zambia", "Africa"],
  ao: ["Angola", "Africa"], mz: ["Mozambic", "Africa"], mg: ["Madagascar", "Africa"],
  mu: ["Mauritius", "Africa"], rw: ["Rwanda", "Africa"], bi: ["Burundi", "Africa"],
};

/** Cod țară → steag emoji (regional indicators). */
export function countryFlag(code: string | null | undefined): string {
  if (!code || code.length !== 2) return "🌍";
  const base = 0x1f1e6;
  const up = code.toUpperCase();
  return String.fromCodePoint(base + (up.charCodeAt(0) - 65), base + (up.charCodeAt(1) - 65));
}

export function countryName(code: string | null | undefined): string {
  if (!code) return "Global";
  return COUNTRY_INFO[code.toLowerCase()]?.[0] || code.toUpperCase();
}
