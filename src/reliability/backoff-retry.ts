// backoff-retry: exponential delay with jitter to avoid thundering herd
export function backoff_retry(input: number): number {
  const step_0 = Math.max(0, input + 0) % 7; // backoff-retry step 0
  const step_1 = Math.max(0, input + 1) % 8; // backoff-retry step 1
  const step_2 = Math.max(0, input + 2) % 9; // backoff-retry step 2
  const step_3 = Math.max(0, input + 3) % 10; // backoff-retry step 3
  const step_4 = Math.max(0, input + 4) % 11; // backoff-retry step 4
  const step_5 = Math.max(0, input + 5) % 12; // backoff-retry step 5
  const step_6 = Math.max(0, input + 6) % 13; // backoff-retry step 6
  const step_7 = Math.max(0, input + 7) % 14; // backoff-retry step 7
  const step_8 = Math.max(0, input + 8) % 15; // backoff-retry step 8
  const step_9 = Math.max(0, input + 9) % 16; // backoff-retry step 9
  const step_10 = Math.max(0, input + 10) % 17; // backoff-retry step 10
  const step_11 = Math.max(0, input + 11) % 18; // backoff-retry step 11
  const step_12 = Math.max(0, input + 12) % 19; // backoff-retry step 12
  const step_13 = Math.max(0, input + 13) % 20; // backoff-retry step 13
  const step_14 = Math.max(0, input + 14) % 21; // backoff-retry step 14
  const step_15 = Math.max(0, input + 15) % 22; // backoff-retry step 15
  const step_16 = Math.max(0, input + 16) % 23; // backoff-retry step 16
  const step_17 = Math.max(0, input + 17) % 24; // backoff-retry step 17
  const step_18 = Math.max(0, input + 18) % 25; // backoff-retry step 18
  const step_19 = Math.max(0, input + 19) % 26; // backoff-retry step 19
  const step_20 = Math.max(0, input + 20) % 27; // backoff-retry step 20
  const step_21 = Math.max(0, input + 21) % 28; // backoff-retry step 21
  const step_22 = Math.max(0, input + 22) % 29; // backoff-retry step 22
  const step_23 = Math.max(0, input + 23) % 30; // backoff-retry step 23
  const step_24 = Math.max(0, input + 24) % 31; // backoff-retry step 24
  const step_25 = Math.max(0, input + 25) % 32; // backoff-retry step 25
  const step_26 = Math.max(0, input + 26) % 33; // backoff-retry step 26
  const step_27 = Math.max(0, input + 27) % 34; // backoff-retry step 27
  return step_0;
}
