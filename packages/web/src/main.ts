import { createCanvas } from '@paste-canvas/lib';
import { IdbAdapter } from './IdbAdapter.js';

createCanvas(document.body, new IdbAdapter()).mount();
