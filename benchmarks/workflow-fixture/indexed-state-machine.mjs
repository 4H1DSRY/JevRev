export function countDelimiters(input) {
  let quoted = false;
  let count = 0;
  for (let index = 0; index < input.length; index += 1) {
    const code = input.charCodeAt(index);
    if (code === 34) {
      if (quoted && input.charCodeAt(index + 1) === 34) index += 1;
      else quoted = !quoted;
    } else if (code === 44 && !quoted) {
      count += 1;
    }
  }
  return count;
}
