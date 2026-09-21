export function countDelimiters(input) {
  const characters = Array.from(input);
  let quoted = false;
  let count = 0;
  for (let index = 0; index < characters.length; index += 1) {
    const character = characters[index];
    if (character === '"') {
      if (quoted && characters[index + 1] === '"') index += 1;
      else quoted = !quoted;
    } else if (character === "," && !quoted) {
      count += 1;
    }
  }
  return count;
}
