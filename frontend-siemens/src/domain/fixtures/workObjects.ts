import type { Role, WorkObject } from '../types';
import { commercialWorkObjects } from './commercial';
import { productionWorkObjects } from './production';
import { financeWorkObjects } from './finance';
import { directorWorkObjects } from './director';
import { operatorWorkObjects } from './operator';
import { warehouseWorkObjects } from './warehouse';
import { adminWorkObjects } from './admin';

export const workObjects: Record<Role, WorkObject[]> = {
  commercial: commercialWorkObjects,
  production: productionWorkObjects,
  finance: financeWorkObjects,
  director: directorWorkObjects,
  operator: operatorWorkObjects,
  warehouse: warehouseWorkObjects,
  admin: adminWorkObjects,
};
