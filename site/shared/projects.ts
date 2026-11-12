/**
 * Titles of the recorded projects (projects/manifest.json in the repo root), and of ones older runs
 * replayed, by id: older results don't carry their titles.
 */
export const PROJECT_TITLES: Record<string, string> = {
  "318213127": "Scratch Bloons TD",
  "324569477": "Doom v0.2.4",
  "425324462": "[Discontinued] 3D Obj Importer",
  "475073453": "Navier Stokes Fluid Simulation",
  "531881458": "BBC Model B Emulator (with 60+ games)",
  "621621130": "Flow field pathfinding",
  "650322979": "NES Emulator v1.1.1",
  "1059423894": "Particle Lenia",
  "1137819146": "Pretty fast 3D renderer v2.5.9",
  "1143869507": "Conway's game of life V9.9 [featuring Hashlife]",
  "1146991627": "Goopy Tech Demo",
  "1201938491": "Linux 6.1.14-rv32ima On Scratch",
  "1274137785": "SGBE Gameboy emulator V1.20",
  "1312523445": "Glue3D Maze Demo",
};

export const projectTitle = (id: string): string => PROJECT_TITLES[id] ?? id;
