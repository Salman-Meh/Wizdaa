/**
 * Migration registry
 * Import all migrations here in order.
 */

import { Migration } from '../migrator';
import migration001 from './001_initial_schema';

const migrations: Migration[] = [
  migration001,
];

export default migrations;
