import enquirer from 'enquirer';
import chalk from 'chalk';
import cfonts from 'cfonts';
import { execa } from 'execa';
import { installE2B } from './providers/e2b.js';
import { installDaytona } from './providers/daytona.js';
import { authenticate, checkAuth, isDaytonaInstalled, isE2BInstalled } from '../utils/auth.js';
import { AGENT_TEMPLATES, SANDBOX_PROVIDERS } from '../../constants/enums.js';

const { prompt } = enquirer;

async function checkDockerStatus(): Promise<{ isInstalled: boolean; isRunning: boolean }> {
  try {
    // Check if Docker is installed
    await execa('docker', ['--version']);
    
    try {
      // Check if Docker daemon is running
      await execa('docker', ['info']);
      return { isInstalled: true, isRunning: true };
    } catch {
      return { isInstalled: true, isRunning: false };
    }
  } catch {
    return { isInstalled: false, isRunning: false };
  }
}

export async function initCommand() {
  try {
    // Display banner
    cfonts.say('VIBEKIT', {
      font: 'block',
      align: 'left',
      colors: ['#FFA500'],
      background: 'transparent',
      letterSpacing: 1,
      lineHeight: 1,
      space: true,
      maxLength: '0',
      gradient: false,
      independentGradient: false,
      transitionGradient: false,
      env: 'node'
    });
    
    // Prompt for provider selection
    console.log(chalk.blue('🖖 Welcome to VibeKit Setup! 🖖\n'));
    console.log(chalk.gray('↑/↓: Navigate • Space: Select • Enter: Confirm\n'));
    
    const { providers } = await prompt<{ providers: SANDBOX_PROVIDERS[] }>({
      type: 'multiselect',
      name: 'providers',
      message: 'Which providers would you like to set up?',
      choices: Object.entries(SANDBOX_PROVIDERS).map(([key, value]) => ({
        name: value,
        message: value
      }))
    });

    if (providers.length === 0) {
      console.log(chalk.yellow('No providers selected. Exiting.'));
      process.exit(0);
    }

    // Prompt for template selection
    const { templates } = await prompt<{ templates: string[] }>({
      type: 'multiselect',
      name: 'templates',
      message: 'Which agent templates would you like to install?',
      choices: AGENT_TEMPLATES.map(template => ({
        name: template.name,
        message: template.display
      }))
    });

    if (templates.length === 0) {
      console.log(chalk.yellow('\nNo templates selected. Exiting setup.'));
      return;
    }

    // Get resource allocation
    console.log(chalk.gray('\nConfigure resource allocation for your providers:'));
    const { cpu, memory, disk } = await prompt<{ cpu: string; memory: string; disk: string }>([
      {
        type: 'input',
        name: 'cpu',
        message: 'CPU cores per provider (Recommended: 2-4 cores):',
        initial: '2',
        validate: (value: string) => {
          const num = parseInt(value);
          return !isNaN(num) && num > 0 ? true : 'Please enter a valid number';
        }
      },
      {
        type: 'input',
        name: 'memory',
        message: 'Memory (MB) per provider (Recommended: 1024-4096 MB):',
        initial: '1024',
        validate: (value: string) => {
          const num = parseInt(value);
          return !isNaN(num) && num > 0 ? true : 'Please enter a valid number';
        }
      },
      {
        type: 'input',
        name: 'disk',
        message: 'Disk space (GB) for Daytona (Recommended: 1-3 GB):',
        initial: '1',
        validate: (value: string) => {
          const num = parseInt(value);
          return !isNaN(num) && num > 0 ? true : 'Please enter a valid number';
        },
        skip: () => !providers.includes(SANDBOX_PROVIDERS.DAYTONA)
      }
    ]);

    const config = {
      cpu: parseInt(cpu),
      memory: parseInt(memory),
      disk: parseInt(disk)
    };

    // Check Docker once upfront since all providers need it
    console.log(chalk.blue('\n🐳 Checking Docker...'));
    const dockerStatus = await checkDockerStatus();
    if (!dockerStatus.isInstalled) {
      console.log(chalk.red(
        '❌ Docker not found.\n' +
        'Please install Docker from: https://docker.com/get-started and try again.'
      ));
      console.log(chalk.red('\n❌ Setup failed: Docker is required for all providers\n'));
      return;
    }
    
    if (!dockerStatus.isRunning) {
      console.log(chalk.red(
        '❌ Docker is not running.\n' +
        'Please start Docker and try again.'
      ));
      console.log(chalk.red('\n❌ Setup failed: Docker must be running to deploy templates\n'));
      return;
    }
    
    console.log(chalk.green('✅ Docker is installed and running'));

    // Install selected providers
    let successfulProviders = 0;
    let failedProviders = 0;
    
    for (const provider of providers) {
      let isAuthenticated = false;
      
      // Check if we need to install the CLI first
      const needsInstall = provider === SANDBOX_PROVIDERS.E2B 
        ? !(await isE2BInstalled()) 
        : !(await isDaytonaInstalled());
      if (needsInstall) {
        console.log(chalk.yellow(`\n🔧 ${provider} CLI needs to be installed`));
        const installed = await authenticate(provider);
        if (!installed) {
          console.log(chalk.yellow(`\nPlease install ${provider} CLI and try again.`));
          failedProviders++;
          continue; // Skip to next provider
        }
      }
      
      // Now check authentication
      console.log(chalk.blue(`\n🔐 Checking ${provider} authentication...`));
      const authStatus = await checkAuth(provider);
      
      if (!authStatus.isAuthenticated) {
        console.log(chalk.yellow(`🔑 Authentication required for ${provider}`));
        const success = await authenticate(provider);
        if (!success) {
          console.log(chalk.yellow(`\nPlease authenticate with ${provider} and try again.`));
          failedProviders++;
          continue; // Skip to next provider
        }
        
        // Verify authentication after login attempt
        const newAuthStatus = await checkAuth(provider);
        if (!newAuthStatus.isAuthenticated) {
          console.log(chalk.red(`❌ Failed to authenticate with ${provider}`));
          failedProviders++;
          continue; // Skip to next provider
        }
        isAuthenticated = true;
      } else {
        console.log(chalk.green(`✅ Already authenticated with ${provider}`));
        isAuthenticated = true;
      }
      
      if (!isAuthenticated) {
        failedProviders++;
        continue; // Skip to next provider if not authenticated
      }

      // Proceed with installation (Docker already verified)
      let installationSuccess = false;
      if (provider === SANDBOX_PROVIDERS.E2B) {
        installationSuccess = await installE2B(config, templates);
      } else if (provider === SANDBOX_PROVIDERS.DAYTONA) {
        installationSuccess = await installDaytona({ ...config, memory: Math.floor(config.memory / 1024) }, templates);
      }
      
      if (installationSuccess) {
        successfulProviders++;
      } else {
        failedProviders++;
      }
    }

    // Show final result based on success/failure
    if (successfulProviders > 0 && failedProviders === 0) {
      console.log(chalk.green('\n✅ Setup complete!\n'));
    } else if (successfulProviders > 0 && failedProviders > 0) {
      console.log(chalk.yellow(`\n⚠️  Setup partially complete: ${successfulProviders} succeeded, ${failedProviders} failed\n`));
    } else {
      console.log(chalk.red('\n❌ Setup failed: No providers were successfully configured\n'));
    }
  } catch (error) {
    console.error(chalk.red('\n❌ Setup failed:'), error instanceof Error ? error.message : error);
    process.exit(1);
  }
}