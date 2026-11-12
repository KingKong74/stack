// Retired compatibility endpoint. Keep stored sprint history; all planning and
// organisation now use milestones and slices. Never accept a legacy write.
import { Router } from 'express';
export const SPRINT_SLICE_ONLY = 'Sprints have been retired. Use milestones and slices; item sprint fields cannot be written.';
export const sprints = Router({ mergeParams: true });
sprints.use((_req, res) => res.status(410).json({ error: SPRINT_SLICE_ONLY }));
