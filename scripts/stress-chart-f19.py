# FAZA 19b — grafic rezultate stres test REAL (din stress-results-f19.json)
import json
import matplotlib.font_manager as fm

fm.fontManager.addfont('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf')

import matplotlib.pyplot as plt

plt.rcParams['font.sans-serif'] = ['DejaVu Sans']
plt.rcParams['axes.unicode_minus'] = False

with open('/home/z/my-project/scripts/stress-results-f19.json') as f:
    data = json.load(f)

stages_a = [r for r in data['stages'] if r['phase'] == 'A-brut']
stages_b = [r for r in data['stages'] if r['phase'] == 'B-protecție']

x_a = [r['targetConcurrency'] for r in stages_a]
rps_a = [r['rps'] for r in stages_a]
p95_a = [r['p95Ms'] / 1000 for r in stages_a]
t429_a = [r['server']['rps429'] for r in stages_a]

x_b = [r['targetConcurrency'] for r in stages_b]
rps_b = [r['rps'] for r in stages_b]
p95_b = [r['p95Ms'] / 1000 for r in stages_b]
t429_b = [r['server']['rps429'] for r in stages_b]

fig, (ax1, ax2) = plt.subplots(2, 1, figsize=(11, 8.5), constrained_layout=True)
fig.suptitle('Stres test REAL — căutări simultane (Faza 19b) • instanță unică dev, HTTP real, zero mock',
             fontsize=13, fontweight='bold')

w = 0.38
targets = [250, 1_000, 2_500, 5_000, 10_000]
rps_a_map = {r['targetConcurrency']: r['rps'] for r in stages_a}
rps_b_map = {r['targetConcurrency']: r['rps'] for r in stages_b}
p95_a_map = {r['targetConcurrency']: r['p95Ms'] / 1000 for r in stages_a}
p95_b_map = {r['targetConcurrency']: r['p95Ms'] / 1000 for r in stages_b}
t429_a_map = {r['targetConcurrency']: r['server']['rps429'] for r in stages_a}
t429_b_map = {r['targetConcurrency']: r['server']['rps429'] for r in stages_b}
to_a_map = {r['targetConcurrency']: r['timeouts'] for r in stages_a}
to_b_map = {r['targetConcurrency']: r['timeouts'] for r in stages_b}
xs = range(len(targets))
rps_a = [rps_a_map.get(t, 0) for t in targets]
rps_b = [rps_b_map.get(t, 0) for t in targets]
p95_a = [p95_a_map.get(t, 0) for t in targets]
p95_b = [p95_b_map.get(t, 0) for t in targets]
t429_a = [t429_a_map.get(t, 0) for t in targets]
t429_b = [t429_b_map.get(t, 0) for t in targets]
to_a = [to_a_map.get(t, 0) for t in targets]
to_b = [to_b_map.get(t, 0) for t in targets]
labels = [f'{t:,}'.replace(',', '.') for t in targets]

# ── panoul 1: rps + p95 ──
b1 = ax1.bar([i - w / 2 for i in xs], rps_a, width=w, color='#2563eb', label='Faza A — capacitate brută (rps)')
b2 = ax1.bar([i + w / 2 for i in xs], rps_b, width=w, color='#7c3aed', label='Faza B — protecție activă (rps)')
ax1.bar_label(b1, fmt='%.0f', fontsize=8)
ax1.bar_label(b2, fmt='%.0f', fontsize=8)
ax1.set_xticks(list(xs))
ax1.set_xticklabels(labels)
ax1.set_xlabel('Căutări simultane (concurenți in-flight reali)')
ax1.set_ylabel('Cereri/s servite', color='#1d4ed8')
ax1.tick_params(axis='y', labelcolor='#1d4ed8')
ax1.set_ylim(0, max(max(rps_a), max(rps_b)) * 1.25)

ax1b = ax1.twinx()
l1, = ax1b.plot(list(xs), p95_a, 'o--', color='#dc2626', label='P95 A (s)')
l2, = ax1b.plot(list(xs), p95_b, 's--', color='#ea580c', label='P95 B (s)')
ax1b.set_ylabel('Latență P95 (s)', color='#dc2626')
ax1b.tick_params(axis='y', labelcolor='#dc2626')
ax1b.set_ylim(0, 24)
ax1b.axhline(2.0, color='#16a34a', lw=1, ls=':', alpha=0.8)
ax1b.text(len(xs) - 0.55, 2.25, 'țintă P95 ≤ 2s', color='#16a34a', fontsize=8)

lines1 = [b1, b2, l1, l2]
ax1.legend(lines1, [l.get_label() for l in lines1], loc='upper left', fontsize=8, framealpha=0.9)
ax1.set_title('Debit servit vs. latență P95 per treaptă', fontsize=10)

# ── panoul 2: 429 + timeouts ──
bars_429 = ax2.bar([i - w / 2 for i in xs], t429_a, width=w, color='#f59e0b', label='429/s server — Faza A')
bars_429b = ax2.bar([i + w / 2 for i in xs], t429_b, width=w, color='#ef4444', label='429/s server — Faza B (protecție)')
ax2.bar_label(bars_429, fmt='%.1f', fontsize=8)
ax2.bar_label(bars_429b, fmt='%.1f', fontsize=8)
ax2.set_xticks(list(xs))
ax2.set_xticklabels(labels)
ax2.set_xlabel('Căutări simultane (concurenți in-flight reali)')
ax2.set_ylabel('Respingeri 429/s (server origin)', color='#b91c1c')
ax2.tick_params(axis='y', labelcolor='#b91c1c')
ax2.set_ylim(0, max(max(t429_a), max(t429_b)) * 1.3 or 10)

ax2b = ax2.twinx()
l3, = ax2b.plot(list(xs), to_a, 'o--', color='#64748b', label='timeout-uri client A')
l4, = ax2b.plot(list(xs), to_b, 's--', color='#94a3b8', label='timeout-uri client B')
ax2b.set_ylabel('Timeout-uri client (>20s)', color='#64748b')
ax2b.tick_params(axis='y', labelcolor='#64748b')

lines2 = [bars_429, bars_429b, l3, l4]
ax2.legend(lines2, [l.get_label() for l in lines2], loc='upper left', fontsize=8, framealpha=0.9)
ax2.set_title('Protecția la supraîncărcare: 429 controlat (limiter global+local) — ZERO erori 5xx pe toate treptele', fontsize=10)

fig.text(0.01, 0.005,
         'Sursă: scripts/stress-results-f19.json • A = rezervă extinsă operațional prin SQL (fără restart) • B = presetare producție 4.000 tok @ 1.500/s • erori 5xx: 0',
         fontsize=7.5, color='#475569')

out = '/home/z/my-project/scripts/stress-chart-f19.png'
fig.savefig(out, dpi=150)
print('OK →', out)
