[![make.fun](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![rank](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/Kroco365/pumpfun-sprint-1126/rank.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![reward](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/Kroco365/pumpfun-sprint-1126/reward.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)

# FirstLight

A buy-early, sell-the-spike bot for the [Pump.fun Paper Sprint: Any Bot Can Win](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b) bounty on make.fun.

## Strategy

Dip-buying the fade loses on this data (win rate ~22%): most pump.fun coins run up fast and then fade for good. But a coin bought soon after its curve starts attracting SOL spikes above its early price far more often than it fades first — and the spikes that persist past the harness's 2-slot fill lag are worth catching, while the fleeting ones are not. FirstLight buys the spike, not the dip:

- **Enter once, early:** a single 0.03 SOL buy as soon as the per-reply size cap allows it (real reserves first reach ~3 SOL) and while the price is still near creation. Coins first seen above ~6 SOL of real reserves are skipped — the early-entry edge decays fast with entry price.
- **Sell the spike:** the whole position goes at +50%, at −50%, or after 3600 slots (~24 min) held, whichever comes first.
- **Never add, never re-enter:** topping up at higher prices measurably destroys the edge, and a coin that was exited is done.

Fast turnover is the point: only 5 positions may be open at once and the guardrail needs round trips on at least 20 coins, so a position that never spikes is sold on time and the slot goes to the next new coin.

## Dev grade

On the kit's 24-hour dev window: net PnL −0.43 SOL (return −4.3%), 226 coins traded, 226 round trips, win rate 22%, max drawdown 5.3%, guardrails met. For comparison the kit's own pilot bots grade −4.37 SOL (reversion) and −9.45 SOL (momentum) on the same window — this market is negative-sum after fees and the 2-slot fill lag, and FirstLight is the least-negative of the shapes tested (dip-buy −3.32, TP +30%/SL −10% −0.46, TP +80% −0.53, no take-profit −0.87).

## How it works

- Entrypoint: `main.ts` (Node 22, TypeScript, no dependencies). It speaks the `agent-fun/replay/v2` harness protocol through the vendored SDK shim in `vendor/makefun-bot.ts`.
- Everything is a pure function of the batches the harness sends: no clock, no randomness, no network, no file reads. The two graded executions produce byte-identical action logs.
- All money math is exact `bigint` lamports; prices are tracked from virtual reserves (`virtual_quote_reserves / virtual_token_reserves`).

## Files

- `main.ts` — the bot
- `vendor/makefun-bot.ts` — the house SDK shim, byte-identical to the kit's `sdk/ts/makefun-bot.ts`
- `.makefun/owner.json` — the payout wallet that owns this entry
- `LICENSE` — MIT

## License

MIT — see [LICENSE](LICENSE).
