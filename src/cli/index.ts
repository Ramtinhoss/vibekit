#!/usr/bin/env node

import { Command } from 'commander';
import { initCommand } from './commands/init.js';

const program = new Command();

program
  .name('vibekit')
  .description('VibeKit development environment manager')
  .version('0.1.0');

program
  .command('init')
  .description('Initialize VibeKit providers')
  .action(initCommand);

program.parse(process.argv);