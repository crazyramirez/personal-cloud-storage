import type { Message, MessageTable } from '~/utils/i18n';

const es = {
  placeholder: 'Buscar en «{name}»',
  results: 'Resultados de la búsqueda',
  searching: 'Buscando en «{name}» y sus subcarpetas…',
  count: (p) => (Number(p.n) === 1 ? `1 resultado en «${p.name}» y sus subcarpetas` : `${p.n} resultados en «${p.name}» y sus subcarpetas`),
  none: 'Nada coincide con «{q}» en «{name}» ni en sus subcarpetas',
  noFavorites: 'Ningún favorito coincide con la búsqueda',
  noneHint: 'Prueba con otra palabra o con parte del nombre. Se buscan todas las palabras, sin importar mayúsculas ni acentos.',
  everywhere: 'Buscar en todos los archivos',
  truncatedLimit: 'Se muestran los primeros {n} resultados: escribe algo más concreto para ver el resto.',
  truncatedTime: 'Hay muchísimos archivos y la búsqueda se detuvo antes de mirarlo todo: puede que falten resultados. Busca desde una carpeta más concreta.',
  inThisFolder: 'En esta carpeta',
  location: 'En {path}',
  openLocation: 'Abrir ubicación',
  failed: 'No se pudo completar la búsqueda.',
} satisfies MessageTable;

export default {
  es,
  en: {
    placeholder: 'Search “{name}”',
    results: 'Search results',
    searching: 'Searching “{name}” and its subfolders…',
    count: (p) => (Number(p.n) === 1 ? `1 result in “${p.name}” and its subfolders` : `${p.n} results in “${p.name}” and its subfolders`),
    none: 'Nothing matches “{q}” in “{name}” or its subfolders',
    noFavorites: 'No favorites match your search',
    noneHint: 'Try another word or part of the name. All words are searched, ignoring case and accents.',
    everywhere: 'Search all files',
    truncatedLimit: 'Showing the first {n} results: type something more specific to see the rest.',
    truncatedTime: 'There are a huge number of files and the search stopped before checking everything: some results may be missing. Search from a more specific folder.',
    inThisFolder: 'In this folder',
    location: 'In {path}',
    openLocation: 'Open file location',
    failed: 'The search couldn’t be completed.',
  } satisfies Record<keyof typeof es, Message>,
};
