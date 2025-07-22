/**
 * VibeKit Dagger Local Sandbox Provider
 * 
 * Implements the same interface as E2B and Daytona providers but uses Dagger
 * for local containerized development environments with ARM64 agent images.
 */

import { connect } from "@dagger.io/dagger";
import type { Client, Container, Directory } from "@dagger.io/dagger";
import { Octokit } from "@octokit/rest";
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

// Interface definitions matching E2B/Northflank patterns
export interface SandboxExecutionResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface SandboxCommandOptions {
  timeoutMs?: number;
  background?: boolean;
  onStdout?: (data: string) => void;
  onStderr?: (data: string) => void;
}

export interface SandboxCommands {
  run(
    command: string,
    options?: SandboxCommandOptions
  ): Promise<SandboxExecutionResult>;
}

export interface SandboxInstance {
  sandboxId: string;
  commands: SandboxCommands;
  kill(): Promise<void>;
  pause(): Promise<void>;
  getHost(port: number): Promise<string>;
}

export interface SandboxProvider {
  create(
    envs?: Record<string, string>,
    agentType?: "codex" | "claude" | "opencode" | "gemini",
    workingDirectory?: string
  ): Promise<SandboxInstance>;
  resume(sandboxId: string): Promise<SandboxInstance>;
}

export type AgentType = "codex" | "claude" | "opencode" | "gemini";

export interface LocalDaggerConfig {
  githubToken?: string;
  preferRegistryImages?: boolean; // If true, use registry images instead of building from Dockerfiles
}

export interface GitConfig {
  repoUrl: string;
  branch?: string;
  commitMessage?: string;
}

export interface PRConfig {
  title: string;
  body: string;
  headBranch: string;
  baseBranch?: string;
}

// Helper function to get Dockerfile path based on agent type
const getDockerfilePathFromAgentType = (agentType?: AgentType): string | undefined => {
  if (agentType === "claude") {
    return "assets/dockerfiles/Dockerfile.claude";
  } else if (agentType === "codex") {
    return "assets/dockerfiles/Dockerfile.codex";
  } else if (agentType === "opencode") {
    return "assets/dockerfiles/Dockerfile.opencode";
  } else if (agentType === "gemini") {
    return "assets/dockerfiles/Dockerfile.gemini";
  }
  return undefined; // fallback to base image
};

// Helper to get registry image name (updated to use public Docker Hub images)
const getRegistryImage = (agentType?: AgentType): string => {
  const baseRegistry = "joedanziger";
  switch (agentType) {
    case "claude":
      return `${baseRegistry}/vibekit-claude:latest`;
    case "codex":
      return `${baseRegistry}/vibekit-codex:latest`;
    case "gemini":
      return `${baseRegistry}/vibekit-gemini:latest`;
    case "opencode":
      return `${baseRegistry}/vibekit-opencode:latest`;
    default:
      return "ubuntu:24.04"; // fallback for unknown agent types
  }
};

// Helper to get tagged image name (for local builds only)
const getImageTag = (agentType?: AgentType): string => {
  return `vibekit-${agentType || 'default'}:latest`;
};

// Local Dagger implementation with proper workspace state persistence
class LocalDaggerSandboxInstance implements SandboxInstance {
  private isRunning = true;
  private octokit?: Octokit;
  private workspaceDirectory: Directory | null = null;
  private baseContainer: Container | null = null;
  private initializationPromise: Promise<void> | null = null;

  constructor(
    public sandboxId: string,
    private image: string, // Fallback image if no Dockerfile
    private envs?: Record<string, string>,
    private workDir?: string,
    private githubToken?: string,
    private dockerfilePath?: string, // Path to Dockerfile if building from source
    private agentType?: AgentType
  ) {
    if (githubToken) {
      this.octokit = new Octokit({ auth: githubToken });
    }
  }

  private async ensureInitialized(): Promise<void> {
    if (!this.initializationPromise) {
      this.initializationPromise = this.initializeBaseContainer();
    }
    await this.initializationPromise;
  }

  private async initializeBaseContainer(): Promise<void> {
    await connect(async (client) => {
      // Create the base container once and store it for reuse
      this.baseContainer = await this.createBaseContainer(client, this.dockerfilePath, this.agentType);
    });
  }

  get commands(): SandboxCommands {
    return {
      run: async (command: string, options?: SandboxCommandOptions): Promise<SandboxExecutionResult> => {
        await this.ensureInitialized();
        
        let result: SandboxExecutionResult = { exitCode: 1, stdout: "", stderr: "Command execution failed" };
        
        await connect(async (client) => {
          try {
            // Get or create persistent workspace container using our reusable base
            let container = await this.getWorkspaceContainer(client);
            
            if (options?.background) {
              // Background execution: start and detach
              container = container.withExec(["sh", "-c", command], { 
                experimentalPrivilegedNesting: true 
              });
              
              // CRITICAL: Export the workspace directory to capture any changes
              this.workspaceDirectory = container.directory(this.workDir || "/vibe0");
              
              result = {
                exitCode: 0,
                stdout: `Background process started: ${command}`,
                stderr: "",
              };
            } else {
              // Foreground execution with output
              container = container.withExec(["sh", "-c", command]);
              
              // CRITICAL: Export the workspace directory to capture filesystem changes
              this.workspaceDirectory = container.directory(this.workDir || "/vibe0");
              
              try {
                // Execute the command and get output
                const stdout = await container.stdout();
                const stderr = await container.stderr();
                
                // Call streaming callbacks if provided
                if (options?.onStdout && stdout) {
                  options.onStdout(stdout);
                }
                if (options?.onStderr && stderr) {
                  options.onStderr(stderr);
                }
                
                result = {
                  exitCode: 0,
                  stdout: stdout,
                  stderr: stderr,
                };
              } catch (execError) {
                // If the container execution failed, extract exit code and throw for proper error handling
                const errorMessage = execError instanceof Error ? execError.message : String(execError);
                const exitCode = errorMessage.includes('exit code') 
                  ? parseInt(errorMessage.match(/exit code (\d+)/)?.[1] || '1') 
                  : 1;
                
                // For foreground commands, throw the error so base agent can handle it
                throw new Error(`Command failed with exit code ${exitCode}: ${errorMessage}`);
              }
            }
          } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            const exitCode = errorMessage.includes('exit code') 
              ? parseInt(errorMessage.match(/exit code (\d+)/)?.[1] || '1') 
              : 1;
              
            result = {
              exitCode: exitCode,
              stdout: "",
              stderr: errorMessage,
            };
          }
        });
        
        return result;
      },
    };
  }

  /**
   * Get or create a persistent workspace container that maintains state across commands
   * This is the key method that makes our implementation work like E2B/Northflank
   */
  private async getWorkspaceContainer(client: Client): Promise<Container> {
    if (!this.baseContainer) {
      throw new Error("Base container not initialized");
    }

    // Start with our cached base container but create a new instance for this session
    let container = this.baseContainer;
    
    // If we have a saved workspace directory, restore it using withDirectory (copies content)
    if (this.workspaceDirectory) {
      container = container.withDirectory(this.workDir || "/vibe0", this.workspaceDirectory);
    } else {
      // First time: ensure working directory exists
      container = container.withExec(["mkdir", "-p", this.workDir || "/vibe0"]);
    }
    
    // Ensure we're in the working directory
    container = container.withWorkdir(this.workDir || "/vibe0");
    
    return container;
  }

  private async createBaseContainer(client: Client, dockerfilePath?: string, agentType?: AgentType): Promise<Container> {
    let container: Container;

    try {
      // Priority 1: Always try public registry image first for agent types (fastest)
      const registryImage = getRegistryImage(agentType);
      if (agentType && registryImage !== "ubuntu:24.04") {
        console.log(`🚀 Trying public registry image: ${registryImage}`);
        try {
          container = client.container().from(registryImage);
          console.log(`✅ Successfully loaded ${registryImage} from registry`);
          // If we get here, registry worked - skip Dockerfile build
        } catch (registryError) {
          console.log(`⚠️ Registry failed, falling back to Dockerfile: ${registryError instanceof Error ? registryError.message : String(registryError)}`);
          throw registryError; // This will trigger the catch block below
        }
      } else if (dockerfilePath) {
        // Priority 2: Build from Dockerfile (slower fallback)
        console.log(`🏗️ Building from Dockerfile: ${dockerfilePath}`);
        const context = client.host().directory(".");
        container = client
          .container()
          .build(context, { dockerfile: dockerfilePath });
        
        const imageTag = getImageTag(agentType);
        // Export to local Docker daemon for future use
        try {
          await container.export(imageTag);
          console.log(`✅ Image ${imageTag} built and exported to local Docker`);
        } catch (exportError) {
          console.log(`Note: Could not export ${imageTag} to local Docker: ${exportError instanceof Error ? exportError.message : String(exportError)}`);
        }
      } else {
        // Priority 3: Use fallback base image
        console.log(`🔄 Using fallback base image: ${this.image}`);
        container = client.container().from(this.image);
      }
    } catch (error) {
      console.error(`❌ Error with primary image strategy: ${error instanceof Error ? error.message : String(error)}`);
      
      // Fallback chain: try Dockerfile -> base image
      if (dockerfilePath) {
        try {
          console.log(`🔄 Falling back to Dockerfile build: ${dockerfilePath}`);
          const context = client.host().directory(".");
          container = client
            .container()
            .build(context, { dockerfile: dockerfilePath });
        } catch (dockerfileError) {
          console.error(`❌ Dockerfile build failed: ${dockerfileError instanceof Error ? dockerfileError.message : String(dockerfileError)}`);
          console.log(`🔄 Using final fallback: ${this.image}`);
          container = client.container().from(this.image);
        }
      } else {
        console.log(`🔄 Using fallback base image: ${this.image}`);
        container = client.container().from(this.image);
      }
    }

    // Add environment variables
    if (this.envs) {
      for (const [key, value] of Object.entries(this.envs)) {
        container = container.withEnvVariable(key, value);
      }
    }

    // Add GitHub token for git operations (if provided via config)
    if (this.githubToken) {
      container = container.withEnvVariable("GITHUB_TOKEN", this.githubToken);
    }

    return container;
  }

  // File operations for git workflow
  async readFile(path: string): Promise<string> {
    await this.ensureInitialized();
    
    let content = "";
    await connect(async (client) => {
      if (!this.baseContainer) {
        throw new Error("Base container not initialized");
      }
      
      const container = await this.getWorkspaceContainer(client);
      content = await container.file(path).contents();
    });
    return content;
  }

  async writeFile(path: string, content: string): Promise<void> {
    await this.ensureInitialized();
    
    await connect(async (client) => {
      if (!this.baseContainer) {
        throw new Error("Base container not initialized");
      }
      
      let container = await this.getWorkspaceContainer(client);
      container = container.withNewFile(path, content);
      // CRITICAL: Export the workspace directory to persist the file write
      this.workspaceDirectory = container.directory(this.workDir || "/vibe0");
    });
  }

  async createBranch(branchName: string): Promise<SandboxExecutionResult> {
    return await this.commands.run(`git checkout -b ${branchName}`);
  }

  async commitChanges(message: string): Promise<SandboxExecutionResult> {
    await this.commands.run('git add .');
    return await this.commands.run(`git commit -m "${message}"`);
  }

  async pushChanges(branchName: string): Promise<SandboxExecutionResult> {
    return await this.commands.run(`git push origin ${branchName}`);
  }

  // GitHub API integration for PR creation
  async createPullRequest(prConfig: PRConfig): Promise<{ success: boolean; prUrl?: string; error?: string }> {
    if (!this.octokit || !this.githubToken) {
      return { success: false, error: "GitHub token not configured" };
    }

    try {
      // Extract owner/repo from current git remote
      const remoteResult = await this.commands.run('git remote get-url origin');
      const repoMatch = remoteResult.stdout.match(/github\.com[/:]([\w-]+)\/([\w-]+)(?:\.git)?/);
      
      if (!repoMatch) {
        return { success: false, error: "Could not determine GitHub repository from git remote" };
      }

      const [, owner, repo] = repoMatch;

      const response = await this.octokit.pulls.create({
        owner,
        repo,
        title: prConfig.title,
        body: prConfig.body,
        head: prConfig.headBranch,
        base: prConfig.baseBranch || 'main',
      });

      return {
        success: true,
        prUrl: response.data.html_url,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async cloneRepository(gitConfig: GitConfig): Promise<SandboxExecutionResult> {
    await this.ensureInitialized();
    
    let cloneResult: SandboxExecutionResult = { exitCode: 1, stdout: "", stderr: "Clone failed" };
    
    await connect(async (client) => {
      // Set basic global git config
      await this.commands.run('git config --global init.defaultBranch main');
      
      // If we have a GitHub token, modify the URL to include authentication
      let cloneUrl = gitConfig.repoUrl;
      if (this.githubToken && gitConfig.repoUrl.includes('github.com')) {
        // Convert github.com URLs to include token authentication
        if (gitConfig.repoUrl.startsWith('https://github.com/')) {
          // Handle HTTPS URLs
          cloneUrl = gitConfig.repoUrl.replace('https://github.com/', `https://x-access-token:${this.githubToken}@github.com/`);
        } else if (gitConfig.repoUrl.startsWith('git@github.com:')) {
          // Handle SSH URLs by converting to HTTPS with token
          cloneUrl = gitConfig.repoUrl
            .replace('git@github.com:', `https://x-access-token:${this.githubToken}@github.com/`);
        } else if (gitConfig.repoUrl.includes('github.com/') && !gitConfig.repoUrl.includes('@')) {
          // Handle plain github.com URLs (add https and token)
          cloneUrl = gitConfig.repoUrl.replace('github.com/', `x-access-token:${this.githubToken}@github.com/`);
          if (!cloneUrl.startsWith('https://')) {
            cloneUrl = 'https://' + cloneUrl;
          }
        }
        
        // Ensure it has .git extension for push operations
        if (!cloneUrl.endsWith('.git')) {
          cloneUrl += '.git';
        }
      }
      
      // Clone the repository with authentication
      const cloneCommand = gitConfig.branch 
        ? `git clone --branch ${gitConfig.branch} ${cloneUrl} .`
        : `git clone ${cloneUrl} .`;
      
      cloneResult = await this.commands.run(cloneCommand);
      
      // IMPORTANT: Set user config in repository context after cloning
      if (cloneResult.exitCode === 0) {
        await this.commands.run('git config user.name "VibeKit Agent"');
        await this.commands.run('git config user.email "agent@vibekit.ai"');
      }
    });
    
    return cloneResult;
  }

  async executeWorkflow(
    gitConfig: GitConfig,
    agentCommand: string,
    prConfig: PRConfig
  ): Promise<{ success: boolean; prUrl?: string; error?: string; logs: string[] }> {
    const logs: string[] = [];
    
    try {
      // Step 1: Clone repository
      logs.push("🔄 Cloning repository...");
      const cloneResult = await this.cloneRepository(gitConfig);
      if (cloneResult.exitCode !== 0) {
        return { success: false, error: `Clone failed: ${cloneResult.stderr}`, logs };
      }
      logs.push("✅ Repository cloned successfully");

      // Step 2: Create feature branch
      logs.push("🔄 Creating feature branch...");
      const branchResult = await this.createBranch(prConfig.headBranch);
      if (branchResult.exitCode !== 0) {
        return { success: false, error: `Branch creation failed: ${branchResult.stderr}`, logs };
      }
      logs.push(`✅ Branch '${prConfig.headBranch}' created`);

      // Step 3: Execute agent command
      logs.push("🔄 Executing agent command...");
      const execResult = await this.commands.run(agentCommand);
      if (execResult.exitCode !== 0) {
        return { success: false, error: `Agent execution failed: ${execResult.stderr}`, logs };
      }
      logs.push("✅ Agent command executed successfully");

      // Step 4: Check for changes
      logs.push("🔄 Checking for changes...");
      const statusResult = await this.commands.run('git status --porcelain');
      if (!statusResult.stdout.trim()) {
        logs.push("ℹ️ No changes detected, skipping commit and PR creation");
        return { success: true, logs };
      }
      logs.push(`📝 Found ${statusResult.stdout.trim().split('\n').length} changed files`);

      // Step 5: Commit changes
      logs.push("🔄 Committing changes...");
      const commitResult = await this.commitChanges(gitConfig.commitMessage || 'VibeKit agent changes');
      if (commitResult.exitCode !== 0) {
        return { success: false, error: `Commit failed: ${commitResult.stderr}`, logs };
      }
      logs.push("✅ Changes committed");

      // Step 6: Push changes
      logs.push("🔄 Pushing changes...");
      const pushResult = await this.pushChanges(prConfig.headBranch);
      if (pushResult.exitCode !== 0) {
        return { success: false, error: `Push failed: ${pushResult.stderr}`, logs };
      }
      logs.push("✅ Changes pushed to remote");

      // Step 7: Create Pull Request
      logs.push("🔄 Creating Pull Request...");
      const prResult = await this.createPullRequest(prConfig);
      if (!prResult.success) {
        return { success: false, error: `PR creation failed: ${prResult.error}`, logs };
      }
      logs.push(`✅ Pull Request created: ${prResult.prUrl}`);

      return {
        success: true,
        prUrl: prResult.prUrl,
        logs
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        logs
      };
    }
  }

  async kill(): Promise<void> {
    this.isRunning = false;
    this.workspaceDirectory = null;
    this.baseContainer = null;
    
    // Close the Dagger connection
    // No explicit action needed here as the connection is managed by the shared connect
  }

  async pause(): Promise<void> {
    // Not applicable for Dagger containers
  }

  async getHost(port: number): Promise<string> {
    return Promise.resolve('localhost'); // Local containers run on localhost
  }
}

export class LocalDaggerSandboxProvider implements SandboxProvider {
  constructor(private config: LocalDaggerConfig = {}) {}

  async create(
    envs?: Record<string, string>,
    agentType?: AgentType,
    workingDirectory?: string
  ): Promise<SandboxInstance> {
    const sandboxId = `dagger-${agentType || 'default'}-${Date.now().toString(36)}`;
    const workDir = workingDirectory || "/vibe0";
    
    // Get Dockerfile path for the agent type (only if not preferring registry images)
    const dockerfilePath = this.config.preferRegistryImages 
      ? undefined 
      : getDockerfilePathFromAgentType(agentType);
    
    // Create sandbox instance with Dockerfile if available and not preferring registry, otherwise use registry/base image
    const instance = new LocalDaggerSandboxInstance(
      sandboxId,
      "ubuntu:24.04", // fallback image
      envs,
      workDir,
      this.config.githubToken,
      dockerfilePath,
      agentType
    );

    return instance;
  }

  async resume(sandboxId: string): Promise<SandboxInstance> {
    // For Dagger, resume is the same as create since containers are ephemeral
    // The workspace state is maintained through the Directory persistence
    return await this.create();
  }
}

export function createLocalProvider(config: LocalDaggerConfig = {}): LocalDaggerSandboxProvider {
  return new LocalDaggerSandboxProvider(config);
}

/**
 * Pre-cache all agent images for faster startup times
 * This function pulls public registry images to local cache and/or builds from Dockerfiles as fallback
 */
export async function prebuildAgentImages(): Promise<{ success: boolean; results: Array<{ agentType: AgentType; success: boolean; error?: string; source: 'registry' | 'dockerfile' | 'cached' }> }> {
  const agentTypes: AgentType[] = ["claude", "codex", "opencode", "gemini"];
  const results: Array<{ agentType: AgentType; success: boolean; error?: string; source: 'registry' | 'dockerfile' | 'cached' }> = [];
  
  console.log("🚀 Pre-caching agent images for faster future startup...");
  console.log("📋 Priority: Registry images → Dockerfile builds → Skip");
  
  for (const agentType of agentTypes) {
    const registryImage = getRegistryImage(agentType);
    const imageTag = getImageTag(agentType);
    const dockerfilePath = getDockerfilePathFromAgentType(agentType);
    
    try {
      console.log(`⏳ Processing ${agentType} agent...`);
      
      // Check if registry image is already cached locally
      const { stdout } = await execAsync(`docker images -q ${registryImage}`);
      if (stdout.trim()) {
        console.log(`✅ ${registryImage} already cached locally`);
        results.push({ agentType, success: true, source: 'cached' });
        continue;
      }
      
      // Try to pull from public registry first (fastest)
      if (registryImage !== "ubuntu:24.04") {
        try {
          console.log(`📥 Pulling ${registryImage} from registry...`);
          await execAsync(`docker pull ${registryImage}`);
          console.log(`✅ ${registryImage} pulled successfully from registry`);
          results.push({ agentType, success: true, source: 'registry' });
          continue;
        } catch (pullError) {
          console.log(`⚠️ Failed to pull ${registryImage}, trying Dockerfile build...`);
        }
      }
      
      // Fallback: Build from Dockerfile using Dagger
      if (dockerfilePath) {
        console.log(`🏗️ Building ${imageTag} from Dockerfile...`);
        await connect(async (client) => {
          const context = client.host().directory(".");
          const container = client
            .container()
            .build(context, { dockerfile: dockerfilePath });
          
          // Export to local Docker daemon
          await container.export(imageTag);
        });
        
        console.log(`✅ ${imageTag} built and cached successfully`);
        results.push({ agentType, success: true, source: 'dockerfile' });
      } else {
        console.log(`⚠️ No registry image or Dockerfile found for ${agentType}, skipping`);
        results.push({ agentType, success: false, error: "No image source available", source: 'dockerfile' });
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`❌ Failed to cache image for ${agentType}: ${errorMessage}`);
      results.push({ agentType, success: false, error: errorMessage, source: 'dockerfile' });
    }
  }
  
  const successCount = results.filter(r => r.success).length;
  const registryCount = results.filter(r => r.success && r.source === 'registry').length;
  const dockerfileCount = results.filter(r => r.success && r.source === 'dockerfile').length;
  const cachedCount = results.filter(r => r.success && r.source === 'cached').length;
  
  console.log(`🎯 Pre-cache complete: ${successCount}/${agentTypes.length} images ready`);
  console.log(`📊 Sources: ${registryCount} registry, ${dockerfileCount} dockerfile, ${cachedCount} cached`);
  
  return {
    success: successCount > 0,
    results
  };
} 