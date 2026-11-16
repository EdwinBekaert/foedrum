// What quiz does with a night's scores: plain data in, plain data out.

/** `scores` with `score` added at the end. */
export function addScore(scores, score) {
  return [...scores, score];
}

/** The teams that have a score, once each, in the order they first scored. */
export function teams(scores) {
  return [...new Set(scores.map((score) => score.team))];
}

/** Each team with its points over every round, as `{ team, points }`, the most points first. */
export function ranking(scores) {
  return teams(scores)
    .map((team) => ({
      team,
      points: scores
        .filter((score) => score.team === team)
        .reduce((sum, score) => sum + score.points, 0),
    }))
    .sort((a, b) => b.points - a.points);
}
