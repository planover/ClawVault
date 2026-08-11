import { Router } from 'express';

export default function createFoldersRouter({ storage }) {
  const r = Router();

  r.get('/', (req, res) => res.json(storage.getFolders()));

  return r;
}
