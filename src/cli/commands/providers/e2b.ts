import { execa } from 'execa';
import ora from 'ora';
import chalk from 'chalk';

// List of available templates and their display names
const TEMPLATES = [
  { name: 'claude', display: 'Claude' },
  { name: 'codex', display: 'Codex' },
  { name: 'gemini', display: 'Gemini' },
  { name: 'opencode', display: 'OpenCode' },
  { name: 'shopify', display: 'Shopify' }
];

type InstallConfig = {
  cpu: number;
  memory: number;
};

export async function installE2B(config: InstallConfig, selectedTemplates?: string[]) {
  console.log(chalk.blue('\n🔧 Setting up E2B...'));
  let spinner: ora.Ora | null = null;
  
  try {
    // Check if E2B CLI is installed
    const isInstalled = await isE2BInstalled();
    
    if (!isInstalled) {
      spinner = ora(chalk.yellow(
        '❌ E2B CLI not found.\n' +
        'Please install it with: npm install -g @e2b/cli and try again.'
      )).fail();
      return false;
    }

    const results = { successful: 0, failed: 0, errors: [] as string[] };
    
    // Filter templates based on selection (default to all if none specified)
    const templatesToInstall = selectedTemplates 
      ? TEMPLATES.filter(template => selectedTemplates.includes(template.name))
      : TEMPLATES;
    
    // Install each selected template
    for (let i = 0; i < templatesToInstall.length; i++) {
      const template = templatesToInstall[i];
      console.log(chalk.blue(`\n🔨 [${i + 1}/${templatesToInstall.length}] Installing ${template.display} template...`));
      
      spinner = ora({
        text: '  Working...',
        color: 'blue',
        spinner: 'dots',
        indent: 2
      }).start();

      try {
        // Check if Dockerfile exists
        const dockerfilePath = `images/Dockerfile.${template.name}`;
        const fs = await import('fs/promises');
        try {
          await fs.access(dockerfilePath);
        } catch (error) {
          throw new Error(`Dockerfile not found at: ${dockerfilePath}`);
        }
        
        // Run E2B setup with provided configuration
        await execa('e2b', [
          'template', 'build',
          '--cpu', config.cpu.toString(),
          '--memory-mb', config.memory.toString(),
          '--name', template.name,  // This will create names like 'claude', 'codex', etc.
          '--dockerfile', `Dockerfile.${template.name}`,
          '--docker-context', 'images'
        ]);

        spinner.succeed(chalk.green(`✅ ${template.display} template installed successfully`));
        results.successful++;
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        
        // Handle specific error cases with user-friendly messages
        let friendlyMessage = `Failed to install ${template.display} template`;
        
        if (errorMessage.includes('already exists')) {
          friendlyMessage = `${template.display} template already exists - skipping`;
          spinner.info(chalk.yellow(`⚠️  ${friendlyMessage}`));
        } else if (errorMessage.includes('Dockerfile not found')) {
          friendlyMessage = `${template.display} template files missing - skipping`;
          spinner.fail(chalk.red(`❌ ${friendlyMessage}`));
          results.errors.push(`${template.display}: Template files not found`);
          results.failed++;
        } else {
          spinner.fail(chalk.red(`❌ ${friendlyMessage}`));
          results.errors.push(`${template.display}: ${errorMessage}`);
          results.failed++;
        }
        
        // Continue with next template instead of throwing
        console.log(chalk.gray('   Continuing with next template...'));
      } finally {
        spinner = null;
      }
    }

    // Print summary
    console.log(chalk.blue('\n📊 Installation Summary:'));
    console.log(chalk.green(`✅ Successfully installed: ${results.successful} templates`));
    
    if (results.failed > 0) {
      console.log(chalk.red(`❌ Failed to install: ${results.failed} templates`));
      if (results.errors.length > 0) {
        console.log(chalk.gray('\nError details:'));
        results.errors.forEach(error => {
          console.log(chalk.gray(`  • ${error}`));
        });
      }
    }
    
    if (results.successful > 0) {
      console.log(chalk.green('\n✨ E2B setup completed with some templates installed!'));
      return true;
    } else {
      console.log(chalk.yellow('\n⚠️  No templates were successfully installed.'));
      return false;
    }
  } catch (error) {
    if (spinner) {
      spinner.fail(chalk.red('Failed to set up E2B'));
    } else {
      console.error(chalk.red('\n❌ Failed to set up E2B:', error instanceof Error ? error.message : 'Unknown error'));
    }
    throw error;
  }
}

async function isE2BInstalled(): Promise<boolean> {
  try {
    await execa('e2b', ['--version']);
    return true;
  } catch {
    return false;
  }
}