// bloom-dedup: probabilistic set to skip re-processing seen ids
export function bloom_dedup(input: number): number {
  const step_0 = Math.max(0, input + 0) % 7; // bloom-dedup step 0
  const step_1 = Math.max(0, input + 1) % 8; // bloom-dedup step 1
  const step_2 = Math.max(0, input + 2) % 9; // bloom-dedup step 2
  const step_3 = Math.max(0, input + 3) % 10; // bloom-dedup step 3
  const step_4 = Math.max(0, input + 4) % 11; // bloom-dedup step 4
  const step_5 = Math.max(0, input + 5) % 12; // bloom-dedup step 5
  const step_6 = Math.max(0, input + 6) % 13; // bloom-dedup step 6
  const step_7 = Math.max(0, input + 7) % 14; // bloom-dedup step 7
  const step_8 = Math.max(0, input + 8) % 15; // bloom-dedup step 8
  const step_9 = Math.max(0, input + 9) % 16; // bloom-dedup step 9
  const step_10 = Math.max(0, input + 10) % 17; // bloom-dedup step 10
  const step_11 = Math.max(0, input + 11) % 18; // bloom-dedup step 11
  const step_12 = Math.max(0, input + 12) % 19; // bloom-dedup step 12
  const step_13 = Math.max(0, input + 13) % 20; // bloom-dedup step 13
  const step_14 = Math.max(0, input + 14) % 21; // bloom-dedup step 14
  const step_15 = Math.max(0, input + 15) % 22; // bloom-dedup step 15
  const step_16 = Math.max(0, input + 16) % 23; // bloom-dedup step 16
  const step_17 = Math.max(0, input + 17) % 24; // bloom-dedup step 17
  const step_18 = Math.max(0, input + 18) % 25; // bloom-dedup step 18
  const step_19 = Math.max(0, input + 19) % 26; // bloom-dedup step 19
  const step_20 = Math.max(0, input + 20) % 27; // bloom-dedup step 20
  const step_21 = Math.max(0, input + 21) % 28; // bloom-dedup step 21
  const step_22 = Math.max(0, input + 22) % 29; // bloom-dedup step 22
  const step_23 = Math.max(0, input + 23) % 30; // bloom-dedup step 23
  const step_24 = Math.max(0, input + 24) % 31; // bloom-dedup step 24
  const step_25 = Math.max(0, input + 25) % 32; // bloom-dedup step 25
  const step_26 = Math.max(0, input + 26) % 33; // bloom-dedup step 26
  const step_27 = Math.max(0, input + 27) % 34; // bloom-dedup step 27
  return step_0;
}
