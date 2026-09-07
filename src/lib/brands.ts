// Curated brand catalogs — resolved through TMDB search server-side
export type BrandDef = {
  id: string;
  name: string;
  emoji: string;
  tmdbCompany?: number; // TMDB company id for /discover
  shows?: string[]; // curated titles searched on TMDB
  type: "movie" | "tv";
  accent: string;
};

export const BRANDS: BrandDef[] = [
  {
    id: "marvel",
    name: "Marvel",
    emoji: "🕷️",
    tmdbCompany: 420,
    type: "movie",
    accent: "#e62429",
  },
  {
    id: "dc",
    name: "DC Comics",
    emoji: "🦇",
    tmdbCompany: 9993,
    type: "movie",
    accent: "#0476f2",
  },
  {
    id: "disney",
    name: "Disney",
    emoji: "🏰",
    tmdbCompany: 2,
    type: "movie",
    accent: "#1a3fb5",
  },
  {
    id: "pixar",
    name: "Pixar",
    emoji: "🎨",
    tmdbCompany: 3,
    type: "movie",
    accent: "#00a8e1",
  },
  {
    id: "ghibli",
    name: "Studio Ghibli",
    emoji: "🌱",
    tmdbCompany: 10342,
    type: "movie",
    accent: "#3fa34d",
  },
  {
    id: "cartoon-network",
    name: "Cartoon Network",
    emoji: "📺",
    shows: [
      "Adventure Time", "The Powerpuff Girls", "Dexter's Laboratory",
      "Johnny Bravo", "Courage the Cowardly Dog", "Ed, Edd n Eddy",
      "Ben 10", "Steven Universe", "Regular Show", "Teen Titans Go!",
      "Samurai Jack", "Foster's Home for Imaginary Friends",
      "Codename: Kids Next Door", "The Grim Adventures of Billy & Mandy",
      "Chowder", "Flapjack", "We Bare Bears", "The Amazing World of Gumball",
    ],
    type: "tv",
    accent: "#000000",
  },
  {
    id: "jetix",
    name: "Jetix",
    emoji: "⚡",
    shows: [
      "Kim Possible", "Jackie Chan Adventures", "W.I.T.C.H.",
      "Totally Spies!", "Yin Yang Yo!", "Pucca",
      "The Emperor's New School", "Dragon Booster", "Get Ed",
      "American Dragon: Jake Long", "Recess", "Fillmore!",
      "Team Galaxy", "Oban Star-Racers", "Shuriken School",
    ],
    type: "tv",
    accent: "#f5a623",
  },
  {
    id: "fox-kids",
    name: "Fox Kids",
    emoji: "🦊",
    shows: [
      "Digimon: Digital Monsters", "Power Rangers", "Beyblade",
      "Medabots", "Mon Colle Knights", "Flint the Time Detective",
      "Shinzo", "Spider-Man", "X-Men", "The Tick",
      "Bobby's World", "Eek! The Cat", "Life with Louie",
      "The PJs", " Arthur", "Pigs Next Door",
    ],
    type: "tv",
    accent: "#d4222a",
  },
  {
    id: "boomerang",
    name: "Boomerang",
    emoji: "🌀",
    shows: [
      "Tom and Jerry", "Looney Tunes", "Scooby-Doo, Where Are You!",
      "The Flintstones", "The Jetsons", "Yogi Bear",
      "Wacky Races", "Droopy, Master Detective", "The Smurfs",
      "Popeye the Sailor", "Top Cat", "Quick Draw McGraw",
      "Josie and the Pussycats", "Speed Buggy", "Hong Kong Phooey",
    ],
    type: "tv",
    accent: "#7b2fbe",
  },
  {
    id: "minimax",
    name: "Minimax",
    emoji: "🌈",
    shows: [
      "Fireman Sam", "Postman Pat", "Shaun the Sheep",
      "Maya the Bee", "The Adventures of Paddington Bear",
      "Wow! Wow! Wubbzy!", "Mio Mao", "Pinky Dinky Doo",
      "Lazy Town", "Tweenies", "The Hoobs", "Barbapapa",
      "Kiri Le Clown", "Ferdy the Ant", "Vivi",
    ],
    type: "tv",
    accent: "#e91e8c",
  },
];

// Telenovela curated catalog (TMDB keyword 207232 = telenovela for discover)
export const TELENOVELA_SHOWS = [
  "La Reina del Flow", "Yo soy Betty, la fea", "Pasión de Gavilanes",
  "El Cuerpo del Deseo", "Rubí", "Rebelde", "Café, con aroma de mujer",
  "María la del Barrio", "Rosalinda", "Wild at Heart",
  "Teresa", "Corazón indomable", "La Usurpadora", "Soy tu dueña",
];

// TMDB genre map (subset used by the platform)
export const TMDB_GENRES: Record<string, { movie: number; tv: number; label: string }> = {
  actiune: { movie: 28, tv: 10759, label: "Acțiune" },
  comedie: { movie: 35, tv: 35, label: "Comedie" },
  drama: { movie: 18, tv: 18, label: "Dramă" },
  groaza: { movie: 27, tv: 9648, label: "Groază" },
  sf: { movie: 878, tv: 10765, label: "Știință-ficțiune" },
  romantice: { movie: 10749, tv: 10749, label: "Romantic" },
  animatie: { movie: 16, tv: 16, label: "Animație" },
  documentar: { movie: 99, tv: 99, label: "Documentar" },
  familie: { movie: 10751, tv: 10751, label: "Familie" },
  mister: { movie: 9648, tv: 9648, label: "Mister" },
  thriller: { movie: 53, tv: 53, label: "Thriller" },
  razboi: { movie: 10752, tv: 10768, label: "Război" },
  western: { movie: 37, tv: 37, label: "Western" },
  muzica: { movie: 10402, tv: 10402, label: "Muzică" },
  fantasy: { movie: 14, tv: 10765, label: "Fantezie" },
  aventura: { movie: 12, tv: 10759, label: "Aventură" },
  crima: { movie: 80, tv: 80, label: "Crimă" },
  reality: { movie: 0, tv: 10764, label: "Reality" },
  stiri: { movie: 0, tv: 10763, label: "Știri" },
  telenovela: { movie: 0, tv: 207232, label: "Telenovelă" },
};
