import type { ClassificationCategory } from './types';

export function parseCategories(value: unknown): ClassificationCategory[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 40) {
    throw new Error('Use between 1 and 40 categories.');
  }
  const names = new Set<string>(['other']);
  const categories = value.map((item: unknown) => {
    if (!item || typeof item !== 'object' || !('name' in item) || typeof item.name !== 'string' ||
      !('description' in item) || typeof item.description !== 'string') {
      throw new Error('Each category needs a name and description.');
    }
    const name = item.name.trim();
    const description = item.description.trim();
    if (!name || name.length > 40 || !description || description.length > 200) {
      throw new Error('Use names of 1-40 characters and descriptions of 1-200 characters.');
    }
    if (names.has(name.toLowerCase())) throw new Error('Category names must be unique. Other is included automatically.');
    names.add(name.toLowerCase());
    return { name, description };
  });
  if (new TextEncoder().encode(JSON.stringify(categories)).length > 6000) {
    throw new Error('Category descriptions are too long to sync. Shorten them and try again.');
  }
  return categories;
}
