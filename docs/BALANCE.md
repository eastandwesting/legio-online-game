# Balance

All figures come from real battles: the real `sim.js` stepped with the real `bot.js` on both seats, both seatings of
every pairing, small random position jitter (6 px unless stated). Tool: `tools/balance.mjs`.

    node tools/balance.mjs <command> [--seed N] [--battles N] [--rounds N] [--workers N] [--root DIR] [--jitter PX]

| Command | Target | What it measures |
|---|---|---|
| `share` | T1 | Win rate by a unit type's share of the army, random armies of equal gold (600-1600, spent gold within 6%) |
| `tourney` | T2, T3 | Round robin of all compositions within 5% of 1050 gold; the default army against compositions of similar cost |
| `matrix` | T7 | Pairwise win rate of single-type armies at equal gold, averaged over budgets 600-1500 |
| `fair` | T4 | Side fairness and battle length (identical armies, jitter) |
| `bot` | T5 | The bot against passive play, a naive rush and a hand-written plan |
| `campaign` | T6 | AI against AI campaigns, battles fought by the real simulation |

`--root DIR` takes `sim.js`, `bot.js` and `campaign.js` from DIR (to try candidate numbers without touching the
repository). `--battles` sets battles per measurement (tourney: rounds). Results depend on `--seed` (for `bot` and `campaign` also slightly on `--workers`; see the note at the end). All tables
below use seed 777001, a seed that was not used while searching for the numbers.

## What changed

| | sword | spear | archer | cav |
|---|---|---|---|---|
| men | 60 -> 58 | 60 | 40 -> 34 | 24 -> 37 |
| dps | 0.040 -> 0.038 | 0.030 -> 0.031 | 0.026 -> 0.028 | 0.070 -> 0.0836 |
| armor | (old value not stated) -> 0.30 | 0.35 -> 0.29 | 0.05 -> 0.09 | 0.20 -> 0.22 |
| special | | antiCav 2 -> 1.75 | ammo 30 -> 32 | charge 1.8 -> 2 |
| price (gold) | 100 | 110 -> 90 | 120 -> 125 | 200 -> 145 |

Why: cavalry was a cost trap. At 200 gold for 24 men, an army that was 30-60% cavalry (by unit count) won only 26.7% of
its battles, and the fine share buckets ranged from 17.7% (lowest) to 71.1% (highest): a player who bought cavalry
in bulk almost always lost, one who bought archers or swords in bulk almost always won. The new numbers make cavalry
cheaper and sturdier, spears cheaper and slightly weaker against horse, and archers a little tougher, so that no
type is a trap or a certain win. Measured match-ups at equal gold (single-type armies, T7): spear beats cavalry
100%, cavalry beats archers 100%, archers beat spear 99%; the sword is the all-rounder: it beats archers 64% and
cavalry 58% and loses to spear 40/60.

## Before and after (seed 777001)

T1, win rate for armies with 30-60% (unit-count share) of a type, and the lowest/highest fine bucket (1-60%).
8000 battles (16000 army samples) each; the tool prints a standard error of at most 1.2 points before and 1.3 points
after for the bucket figures (n per bucket 4618-7382 samples).

| | before | after |
|---|---|---|
| sword 30-60% | 58.7% | 54.7% |
| spear 30-60% | 47.4% | 47.7% |
| archer 30-60% | 63.2% | 51.8% |
| cav 30-60% | 26.7% | 47.7% |
| lowest / highest bucket | 17.7% / 71.1% | 43.0% / 56.7% |
| seat 0 wins (decisive) | 50.1% | 50.0% |

T2, round robin within 5% of 1050 gold (before 158 compositions, 74418 battles, 0 time-outs; after 224 compositions,
149856 battles, 0 time-outs):

| | before | after |
|---|---|---|
| best composition (avg win rate) | [6,0,4,0] 0.98 | [7,0,2,1] 0.81 |
| worst composition | [0,0,0,5] 0.00 | [1,2,0,5] 0.16 |
| spread best - worst | 0.96 | 0.65 |
| compositions above 0.65 / below 0.30 | 50 / 39 (of 153) | 34 / 16 (of 219) |
| lowest single-type army | cavx5 0.00 | cavx7 0.23 |
| compositions that lose to none | 1 | 0 |

Compositions are [sword, spear, archer, cav]. T3: the default army [3,2,2,2] (cost 1160 before, 1020 after) beats
the compositions within 5% of its cost with a mean win rate of 0.332 before (loses to 129 of 197) and 0.618 after
(loses to 55 of 207).

T4-T7 before (the live numbers: the same commands run with `--root` pointing at a copy of the old `sim.js`, `bot.js`
and `campaign.js`) and after, same seed and sizes (before: 6 workers; after: 4 workers for T4/T7, 5 for T5/T6, see the
note below):

| Target | before | after |
|---|---|---|
| T4 default army, side 0 wins | 51.00% of 7990 decisive (+-0.56), median length 25.5 s, longest 88.0 s | 49.62% of 7998 decisive (+-0.56), median 21.4 s, longest 51.6 s |
| T4 default army, jitter 15 | 49.96% (+-0.56) | 48.60% (+-0.56) |
| T4 random identical armies | 49.69% of 7327 decisive (+-0.58) | 50.23% of 7240 decisive (+-0.59) |
| T5 bot, default army: vs passive / naive / scripted | 100.0% / 100.0% / 35.3% | 100.0% / 99.9% / 66.8% |
| T5 bot, random armies: vs passive / naive / scripted | 81.8% / 95.0% / 59.8% | 97.9% / 98.2% / 59.6% |
| T6 campaigns, mirror start: seat 0 wins | 51.4% of decisive (+-2.9) | 48.6% (+-2.9) |
| T6 campaigns, random start: seat 0 wins | 44.4% (+-2.9) | 46.6% (+-2.9) |

T5 has n=2000 per line, T6 300 games per start; before and after there were no turn-limit endings and no unfinished
campaigns, and no time-outs in any battle.

T7, single-type armies at equal gold, averaged over the budgets 600-1500 (row beats column, draws count half):

| before | sword | spear | archer | cav |
|---|---|---|---|---|
| sword | - | 100% | 35% | 100% |
| spear | 0% | - | 0% | 100% |
| archer | 65% | 100% | - | 100% |
| cav | 0% | 0% | 0% | - |

| after | sword | spear | archer | cav |
|---|---|---|---|---|
| sword | - | 40% | 64% | 58% |
| spear | 60% | - | 1% | 100% |
| archer | 36% | 99% | - | 0% |
| cav | 42% | 0% | 100% | - |

## Where this stands

Met: T1 (every fine bucket between 43.0% and 56.7%, cavalry at 30-60% of an army 47.7%), T4, T5, T6, T7.
Not met: T2 (spread among non-single-type compositions 0.65, target under 0.45, was 0.96) and T3 (the default army
wins 0.618 against similarly priced compositions, target at most 0.60, was 0.332). Both moved a long way toward their
targets. The eight worst compositions in the round robin all contain no archers, so archers are what the round robin
rewards most; that is where the next tuning step belongs.

## Note on repeatability

Compare runs with the same `--workers`. A repeat of the same numbers with 4 workers instead of 5 gave identical T4 and
T7 figures, but the T5 and T6 figures moved by about one point (bot vs scripted 67.2% / 58.6% instead of 66.8% /
59.6%; random-start campaigns, seat 0 44.8% instead of 46.6%). That is within the sampling error (n=2000 and n=300),
but it means the tool's statement that results depend on the seed only holds for those two commands at a fixed
worker count.
