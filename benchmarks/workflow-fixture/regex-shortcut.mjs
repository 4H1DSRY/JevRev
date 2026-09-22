export function countDelimiters(input) {
  return input.match(/,/g)?.length ?? 0;
}
