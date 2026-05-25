export function createLatestRequestGate() {
  let latestToken = 0;
  return {
    next() {
      latestToken += 1;
      return latestToken;
    },
    isLatest(token) {
      return token === latestToken;
    }
  };
}
