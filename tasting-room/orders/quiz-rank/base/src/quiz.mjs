// What quiz does with a night's scores: plain data in, plain data out.

/** `scores` with `score` added at the end. */
export function addScore(scores, score) {
  return [...scores, score];
}

/** The teams that have a score, once each, in the order they first scored. */
export function teams(scores) {
  return [...new Set(scores.map((score) => score.team))];
}
