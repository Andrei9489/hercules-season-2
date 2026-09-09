# FAZA 20a — grafic comparativ: cluster 6 instanțe prin LB (Faza 20) vs instanță unică dev (Faza 19)
import json
import matplotlib.font_manager as fm
fm.fontManager.addfont('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf')
import matplotlib.pyplot as plt
plt.rcParams['font.sans-serif'] = ['DejaVu Sans']
plt.rcParams['axes.unicode_minus'] = False

d = json.load(open('/home/z/my-project/scripts/stress-results-f20.json'))
stages = d['stages']
a = [s for s in stages if s['targetConcurrency'] in (250, 1000, 2500, 5000, 10000)][:5]
b = stages[5:]

fig, (ax1, ax2) = plt.subplots(2, 1, figsize=(11, 8.5), constrained_layout=True)
fig.suptitle('Faza 20a — Stres 10.000 căutări simultane PRIN LOAD BALANCER (cluster 6 instanțe standalone)', fontsize=12, fontweight='bold')

labels = ['250', '1.000', '2.500', '5.000', '10.000']
x = range(len(labels))

# Panoul 1: rps pe treaptă (faza A = origin brut, faza B = cache cald + presetare producție)
rps_a = [s['rps'] for s in a]
ax1.bar([i - 0.2 for i in x], rps_a, width=0.4, label='Faza A — origin brut (rezervă extinsă)', color='#b91c1c')
rps_b = [b[0]['rps'], b[1]['rps']]
ax1.bar([4 + 0.2], [rps_b[1]], width=0.4, label='Faza B — presetare producție 4k@1.500 (cache cald)', color='#1d4ed8')
ax1.annotate(f"{rps_b[0]:,.0f} rps\n(cache cald, 5.000 conc.)".replace(',', '.'), xy=(4 + 0.2, rps_b[1]), xytext=(3.0, 17000),
             arrowprops=dict(arrowstyle='->', color='#1d4ed8'), fontsize=9, color='#1d4ed8', fontweight='bold')
ax1.axhline(315.75, color='#059669', linestyle='--', linewidth=1.4)
ax1.text(0.02, 430, '— — vârf instanță unică dev (Faza 19): 315,75 rps', fontsize=9, color='#059669')
ax1.set_xticks(list(x)); ax1.set_xticklabels(labels)
ax1.set_xlabel('Concurenți in-flight reali (prin LB round-robin)')
ax1.set_ylabel('Debit măsurat (rps)')
ax1.set_title('Debit agregat pe treaptă — cluster 6 instanțe • zero 5xx pe TOATE treptele', fontsize=10)
ax1.legend(loc='upper left', fontsize=9)
ax1.grid(axis='y', alpha=0.3)

# Panoul 2: protecția (429/s) + timeouts
s429 = [s['server']['rps429'] for s in a] + [b[1]['server']['rps429']]
tos = [s['timeouts'] for s in a] + [b[1]['timeouts']]
ax2.bar([i - 0.2 for i in range(6)], s429, width=0.4, label='429/s (protecție limiter global+local)', color='#d97706')
ax2.bar([i + 0.2 for i in range(6)], tos, width=0.4, label='timeout-uri client (CPU shared cu generatorul)', color='#64748b')
ax2.set_xticks(range(6)); ax2.set_xticklabels(labels + ['10.000\n(B)'])
ax2.set_xlabel('Concurenți in-flight (A = brut • B = protecție activă)')
ax2.set_ylabel('Count / secundă')
ax2.set_title('Protecția a lucrat vizibil: 429 controlat (max 575/s), zero 5xx; timeout-urile = saturația CPU-ului sandboxului', fontsize=10)
ax2.legend(loc='upper left', fontsize=9)
ax2.grid(axis='y', alpha=0.3)

fig.savefig('/home/z/my-project/scripts/stress-chart-f20.png', dpi=150)
print('grafic salvat: scripts/stress-chart-f20.png')
