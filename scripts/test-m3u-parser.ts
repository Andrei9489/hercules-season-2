// Test rapid parser M3U (Faza 9)
import { parseM3U } from "../src/lib/m3u-parser";

const SAMPLE = `#EXTM3U
#PLAYLIST:Popular News - CODECS.COM

#EXTINF:-1 tvg-id="AlJazeera.qa@English" tvg-logo="https://i.imgur.com/7bRVpnu.png" group-title="News;English",Al Jazeera English (1080p)
https://live-hls-apps-aje-fa.getaj.net/AJE/index.m3u8

#EXTINF:-1 tvg-id="DW.de@Deutsch" tvg-logo="https://i.imgur.com/x0yK9ZL.png" group-title="News;Deutsch",DW English [Not 24/7]
https://dwamdstream102.akamaized.net/hls/live/2015525/dwstream102/index.m3u8

#EXTINF:-1 tvg-id="France24.fr@French" tvg-logo="https://i.imgur.com/7bRVpnu.png" group-title="News;Français",France 24 English (720p) [Geo-blocked]
https://static.france24.com/live/F24_EN_LO_HLS/live_web.m3u8

#EXTINF:-1 tvg-id="RadioOne.ro" group-title="Radio;Music;RO",Radio One FM
https://stream.radioone.ro/live.mp3

#EXTINF:-1 tvg-logo="https://example.com/logo.png" group-title="Documentary",Nat Geo Wild HD
https://cdn.example.com/natgeo.m3u8

https://plain-url-without-extinf.example.com/stream/index.m3u8

#EXTINF:-1,Canal fără URL
`;

const r = parseM3U(SAMPLE);
console.log("=== PARSE M3U ===");
console.log("playlistName:", r.playlistName);
console.log("channels:", r.channels.length, "| skipped:", r.skipped, "| errors:", r.errors);
for (const c of r.channels) {
  console.log(`- "${c.name}" | tvg=${c.tvgId} | groups=[${c.groups.join(", ")}] | q=${c.quality} | geo=${c.geoBlocked} | not247=${c.not247} | radio=${c.isRadio} | logo=${c.logo ? "da" : "nu"} | url=${c.url.slice(0, 50)}`);
}

// validări cheie
const ok =
  r.playlistName === "Popular News - CODECS.COM" &&
  r.channels.length === 6 &&
  r.skipped === 1 && // EXTINF fără URL la final
  r.channels[0].quality === "1080P" && r.channels[0].name === "Al Jazeera English" &&
  r.channels[0].groups.length === 2 &&
  r.channels[0].isRadio === false &&
  r.channels[1].not247 === true &&
  r.channels[2].geoBlocked === true &&
  r.channels[3].isRadio === true &&
  r.channels[5].name.length > 0;

console.log(ok ? "\n✅ TOATE VALIDĂRILE TREC" : "\n❌ VALIDĂRI EȘUATE");
process.exit(ok ? 0 : 1);
