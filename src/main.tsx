import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './ui/App';
import { DexieRepository, FuelTrackerDatabase } from './data/db';
import { FuelTrackerStore } from './data/store';
import './ui/styles.css';

const db = new FuelTrackerDatabase();
const store = new FuelTrackerStore({
  vehicles: new DexieRepository(db.vehicles),
  fillUps: new DexieRepository(db.fillUps),
  pendingFillUps: new DexieRepository(db.pendingFillUps),
});

const container = document.getElementById('root');
if (container === null) throw new Error('missing #root');

createRoot(container).render(
  <StrictMode>
    <App store={store} />
  </StrictMode>,
);
