import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { InputError } from "../domain/errors.js";

export async function createFreshDirectory(directory: string, label: string): Promise<void> {
  const parent = dirname(directory);
  try {
    await mkdir(parent, { recursive: true });
  } catch (error) {
    throw new InputError(`Could not create parent directory for ${label}: ${parent}`, { cause: error });
  }

  try {
    await mkdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new InputError(`${label} directory must not already exist: ${directory}`, { cause: error });
    }
    throw new InputError(`Could not create ${label} directory: ${directory}`, { cause: error });
  }
}
