#!/usr/bin/env node

const dns = require('dns').promises;
const { exec, spawn } = require('child_process');
const { promisify } = require('util');
const fs = require('fs').promises;
const path = require('path');

const execAsync = promisify(exec);

class EnvLoader {
    static async load(envPath = '.env') {
        try {
            const envFile = await fs.readFile(envPath, 'utf8');
            const lines = envFile.split('\n');
            
            for (const line of lines) {
                const trimmedLine = line.trim();
                if (trimmedLine && !trimmedLine.startsWith('#')) {
                    const [key, ...valueParts] = trimmedLine.split('=');
                    if (key && valueParts.length > 0) {
                        const value = valueParts.join('=').replace(/^["']|["']$/g, ''); // Remove quotes
                        process.env[key.trim()] = value;
                    }
                }
            }
        } catch (error) {
            throw new Error(`Failed to load .env file: ${error.message}`);
        }
    }
}

function parsePort(portStr) {
    const trimmed = portStr.trim();
    // Check if protocol is specified, e.g. 2222/tcp or 53/udp
    if (trimmed.includes('/')) {
        const [port, proto] = trimmed.split('/');
        return { raw: trimmed, port: port.trim(), proto: proto.trim().toLowerCase() };
    }
    // If port contains comma e.g. "2222,3333", UFW requires proto (defaults to tcp)
    if (trimmed.includes(',')) {
        return { raw: trimmed, port: trimmed, proto: process.env.PROTOCOL || 'tcp' };
    }
    return { raw: trimmed, port: trimmed, proto: process.env.PROTOCOL || null };
}

function buildUfwCommand(action, ip, portObj) {
    // action: 'allow' or 'delete allow'
    if (portObj.proto) {
        return `sudo ufw ${action} proto ${portObj.proto} from ${ip} to any port ${portObj.port}`;
    }
    return `sudo ufw ${action} from ${ip} to any port ${portObj.port}`;
}

// Load environment variables
async function loadConfig() {
    const envPath = path.join(__dirname, '.env');
    
    try {
        await EnvLoader.load(envPath);
    } catch (error) {
        console.error(`Error loading .env file: ${error.message}`);
        console.error('Please create a .env file in the same directory as this script');
        process.exit(1);
    }
    
    // Parse ports: supports PORTS (e.g. "2222, 3333" or "2222/tcp, 53/udp") or PORT
    const rawPorts = (process.env.PORTS || process.env.PORT || '').toString();
    const ports = rawPorts
        .split(',')
        .map(p => p.trim())
        .filter(p => p.length > 0)
        .map(parsePort);

    if (!ports || ports.length === 0) {
        console.error('Error: No PORT or PORTS defined in .env file');
        process.exit(1);
    }

    if (!process.env.HOSTNAME) {
        console.error('Error: HOSTNAME is not defined in .env file');
        process.exit(1);
    }
    
    // Configuration with environment variables and defaults
    return {
        hostname: process.env.HOSTNAME,
        ports: ports,
        portsDisplay: ports.map(p => p.raw).join(', '),
        port: ports[0].port, // backward compatibility
        updateInterval: (parseInt(process.env.UPDATE_INTERVAL_MINUTES) || 5) * 60 * 1000,
        stateFile: process.env.STATE_FILE || '/tmp/ip_state.json',
        logFile: process.env.LOG_FILE || '/var/log/ufw-ip-updater.log',
        pidFile: process.env.PID_FILE || '/tmp/ufw-ip-updater.pid',
        maxLogSize: parseInt(process.env.MAX_LOG_SIZE_MB || '10') * 1024 * 1024,
        maxLogFiles: parseInt(process.env.MAX_LOG_FILES) || 5,
    };
}
// Configuration
var CONFIG ;

class UFWIPUpdater {
    constructor() {
        this.currentState = null;
        this.isRunning = false;
        this.intervalId = null;
        this.shutdownRequested = false;
    }

    async log(message, level = 'INFO') {
        const timestamp = new Date().toISOString();
        const logMessage = `[${timestamp}] [${level}] ${message}\n`;
        
        console.log(`[${level}] ${message}`);
        
        try {
            await this.rotateLogIfNeeded();
            await fs.appendFile(CONFIG.logFile, logMessage);
        } catch (error) {
            console.warn(`Could not write to log file: ${error.message}`);
        }
    }

    async rotateLogIfNeeded() {
        try {
            const stats = await fs.stat(CONFIG.logFile);
            if (stats.size > CONFIG.maxLogSize) {
                await this.rotateLogs();
            }
        } catch (error) {
            // Log file doesn't exist yet, that's fine
        }
    }

    async rotateLogs() {
        try {
            // Move existing logs
            for (let i = CONFIG.maxLogFiles - 1; i > 0; i--) {
                const oldFile = `${CONFIG.logFile}.${i}`;
                const newFile = `${CONFIG.logFile}.${i + 1}`;
                
                try {
                    await fs.access(oldFile);
                    if (i === CONFIG.maxLogFiles - 1) {
                        await fs.unlink(oldFile); // Delete oldest
                    } else {
                        await fs.rename(oldFile, newFile);
                    }
                } catch (error) {
                    // File doesn't exist, continue
                }
            }
            
            // Move current log to .1
            await fs.rename(CONFIG.logFile, `${CONFIG.logFile}.1`);
            await this.log('Log rotated successfully', 'INFO');
        } catch (error) {
            console.warn(`Log rotation failed: ${error.message}`);
        }
    }

    async loadState() {
        try {
            const data = await fs.readFile(CONFIG.stateFile, 'utf8');
            this.currentState = JSON.parse(data);
            if (this.currentState && this.currentState.ip) {
                await this.log(`Loaded previous state: IP ${this.currentState.ip}`);
            } else {
                await this.log('Previous state file empty or invalid');
                this.currentState = null;
            }
        } catch (error) {
            await this.log('No previous state found, starting fresh');
            this.currentState = null;
        }
    }

    async saveState(ip) {
        const state = {
            ip: ip,
            timestamp: new Date().toISOString(),
            hostname: CONFIG.hostname,
            ports: CONFIG.ports.map(p => p.raw),
            lastUpdate: Date.now()
        };

        try {
            await fs.writeFile(CONFIG.stateFile, JSON.stringify(state, null, 2));
            this.currentState = state;
            await this.log(`State saved: IP ${ip}`);
        } catch (error) {
            await this.log(`Error saving state: ${error.message}`, 'ERROR');
        }
    }

    async resolveHostname() {
        try {
            const addresses = await dns.resolve4(CONFIG.hostname);
            const ip = addresses[0];
            return ip;
        } catch (error) {
            throw new Error(`Failed to resolve ${CONFIG.hostname}: ${error.message}`);
        }
    }

    async removeOldRule(oldIP) {
        for (const portObj of CONFIG.ports) {
            try {
                const cmd = buildUfwCommand('delete allow', oldIP, portObj);
                await this.log(`Removing old UFW rule for ${oldIP} (${portObj.raw})`);
                const { stdout, stderr } = await execAsync(cmd);
                
                if (stderr && !stderr.includes('Could not delete non-existent rule')) {
                    throw new Error(stderr);
                }
                
                await this.log(`Old rule for port ${portObj.raw} removed successfully`);
            } catch (error) {
                if (error.message.includes('Could not delete non-existent rule')) {
                    await this.log(`Old rule for ${oldIP}:${portObj.raw} did not exist, continuing...`);
                } else {
                    throw new Error(`Failed to remove old UFW rule for port ${portObj.raw}: ${error.message}`);
                }
            }
        }
    }

    async addNewRule(newIP) {
        for (const portObj of CONFIG.ports) {
            try {
                const cmd = buildUfwCommand('allow', newIP, portObj);
                await this.log(`Adding new UFW rule for ${newIP} (${portObj.raw})`);
                const { stdout, stderr } = await execAsync(cmd);
                
                if (stderr) {
                    throw new Error(stderr);
                }
                
                await this.log(`New rule for port ${portObj.raw} added successfully: ${stdout.trim()}`);
            } catch (error) {
                throw new Error(`Failed to add new UFW rule for port ${portObj.raw}: ${error.message}`);
            }
        }
    }

    async reloadUFW() {
        try {
            await this.log('Reloading UFW...');
            const { stdout, stderr } = await execAsync('sudo ufw reload');
            
            if (stderr) {
                throw new Error(stderr);
            }
            
            await this.log('UFW reloaded successfully');
        } catch (error) {
            await this.log(`Warning: Failed to reload UFW: ${error.message}`, 'WARN');
        }
    }

    async updateRule() {
        try {
            const currentIP = await this.resolveHostname();
            await this.log(`Resolved ${CONFIG.hostname} to ${currentIP}`);
            
            // Check if IP has changed
            if (this.currentState && this.currentState.ip === currentIP) {
                await this.log(`IP unchanged (${currentIP}), no update needed`);
                return false;
            }
            
            const oldIP = this.currentState ? this.currentState.ip : 'none';
            await this.log(`IP changed from ${oldIP} to ${currentIP}`);
            
            // Remove old rule if exists
            if (this.currentState && this.currentState.ip) {
                await this.removeOldRule(this.currentState.ip);
            }
            
            // Add new rule
            await this.addNewRule(currentIP);
            
            // Reload UFW
            await this.reloadUFW();
            
            // Save new state
            await this.saveState(currentIP);
            
            await this.log('IP update completed successfully');
            return true;
            
        } catch (error) {
            await this.log(`ERROR during update: ${error.message}`, 'ERROR');
            throw error;
        }
    }

    async createPidFile() {
        try {
            await fs.writeFile(CONFIG.pidFile, process.pid.toString());
            await this.log(`PID file created: ${CONFIG.pidFile} (PID: ${process.pid})`);
        } catch (error) {
            await this.log(`Warning: Could not create PID file: ${error.message}`, 'WARN');
        }
    }

    async removePidFile() {
        try {
            await fs.unlink(CONFIG.pidFile);
            await this.log('PID file removed');
        } catch (error) {
            // PID file might not exist, that's ok
        }
    }

    async checkIfAlreadyRunning() {
        try {
            const pidData = await fs.readFile(CONFIG.pidFile, 'utf8');
            const pid = parseInt(pidData.trim());
            
            // Check if process with this PID exists
            try {
                process.kill(pid, 0); // Just check, don't actually kill
                return pid;
            } catch (error) {
                // Process doesn't exist, remove stale PID file
                await fs.unlink(CONFIG.pidFile);
                return null;
            }
        } catch (error) {
            // PID file doesn't exist
            return null;
        }
    }

    async startBackground() {
        // Check if already running
        const existingPid = await this.checkIfAlreadyRunning();
        if (existingPid) {
            console.error(`UFW IP Updater is already running (PID: ${existingPid})`);
            process.exit(1);
        }

        const fsSync = require('fs');
        let outFd = 'ignore';
        let errFd = 'ignore';
        try {
            outFd = fsSync.openSync(CONFIG.logFile, 'a');
            errFd = fsSync.openSync(CONFIG.logFile, 'a');
        } catch (error) {
            // fallback if log file cannot be opened synchronously
        }

        const child = spawn(process.execPath, [path.resolve(__filename), '__worker'], {
            detached: true,
            stdio: ['ignore', outFd, errFd],
            env: process.env
        });

        child.unref();

        console.log(`UFW IP Updater daemon started in background (PID: ${child.pid})`);
        console.log(`Monitoring: ${CONFIG.hostname} (ports: ${CONFIG.portsDisplay})`);
        console.log(`Logs: ${CONFIG.logFile}`);
        process.exit(0);
    }

    async startDaemon() {
        // Check if already running
        const existingPid = await this.checkIfAlreadyRunning();
        if (existingPid) {
            console.error(`UFW IP Updater is already running (PID: ${existingPid})`);
            process.exit(1);
        }

        await this.log('Starting UFW IP Updater Daemon...');
        await this.log(`Monitoring: ${CONFIG.hostname} (ports: ${CONFIG.portsDisplay})`);
        await this.log(`Update interval: ${CONFIG.updateInterval / 1000} seconds`);
        
        this.isRunning = true;
        await this.createPidFile();
        
        // Load initial state
        await this.loadState();
        
        // Perform initial update
        try {
            await this.updateRule();
        } catch (error) {
            await this.log(`Initial update failed: ${error.message}`, 'ERROR');
        }
        
        // Set up interval
        this.intervalId = setInterval(async () => {
            if (this.shutdownRequested) return;
            
            try {
                await this.updateRule();
            } catch (error) {
                await this.log(`Scheduled update failed: ${error.message}`, 'ERROR');
            }
        }, CONFIG.updateInterval);
        
        await this.log('Daemon started successfully');
        
        // Keep process alive
        return new Promise((resolve) => {
            process.on('SIGTERM', () => this.shutdown(resolve));
            process.on('SIGINT', () => this.shutdown(resolve));
            process.on('SIGHUP', () => this.shutdown(resolve));
        });
    }

    async shutdown(resolve) {
        if (this.shutdownRequested) return;
        
        this.shutdownRequested = true;
        await this.log('Shutdown signal received, stopping daemon...');
        
        if (this.intervalId) {
            clearInterval(this.intervalId);
            this.intervalId = null;
        }
        
        this.isRunning = false;
        await this.removePidFile();
        await this.log('UFW IP Updater Daemon stopped');
        
        if (resolve) resolve();
        process.exit(0);
    }

    async getStatus() {
        const existingPid = await this.checkIfAlreadyRunning();
        
        if (existingPid) {
            console.log(`Status: RUNNING (PID: ${existingPid})`);
            
            try {
                const data = await fs.readFile(CONFIG.stateFile, 'utf8');
                const state = JSON.parse(data);
                console.log(`Current IP: ${state.ip}`);
                console.log(`Last Update: ${new Date(state.timestamp).toLocaleString()}`);
            } catch (error) {
                console.log('No state information available');
            }
        } else {
            console.log('Status: STOPPED');
        }
    }

    async stop() {
        const existingPid = await this.checkIfAlreadyRunning();
        
        if (existingPid) {
            console.log(`Stopping UFW IP Updater (PID: ${existingPid})...`);
            try {
                process.kill(existingPid, 'SIGTERM');
                for (let i = 0; i < 15; i++) {
                    await new Promise(res => setTimeout(res, 200));
                    if (!(await this.checkIfAlreadyRunning())) break;
                }
                console.log('Daemon stopped successfully');
            } catch (error) {
                console.error(`Failed to stop process: ${error.message}`);
            }
        } else {
            console.log('UFW IP Updater is not running');
        }
    }
}

// Main execution
async function main() {
    const args = process.argv.slice(2);
    const command = args[0] || 'start';
    CONFIG = await loadConfig() ;

    // Check if running as root/sudo for start commands on POSIX systems
    if ((command === 'start' || command === 'run' || command === '__worker') && process.getuid && process.getuid() !== 0) {
        console.error('This script must be run with sudo privileges to modify UFW rules');
        console.error('Usage: sudo node ufw-ip-updater.js [start|stop|status|restart|help]');
        process.exit(1);
    }

    const updater = new UFWIPUpdater();
    
    try {
        switch (command) {
            case 'start':
                if (args.includes('--foreground') || args.includes('-f')) {
                    await updater.startDaemon();
                } else {
                    await updater.startBackground();
                }
                break;
                
            case 'run':
                await updater.startDaemon();
                break;

            case '__worker':
                await updater.startDaemon();
                break;
                
            case 'stop':
                await updater.stop();
                break;
                
            case 'status':
                await updater.getStatus();
                break;
                
            case 'restart':
                await updater.stop();
                await new Promise(resolve => setTimeout(resolve, 1000));
                await updater.startBackground();
                break;
                
            case 'help':
            case '--help':
            case '-h':
                console.log(`
UFW IP Updater Daemon for Dynamic DNS

This script runs as a daemon and automatically updates UFW firewall rules
every 5 minutes for ${CONFIG.hostname} (ports: ${CONFIG.portsDisplay}).

Usage:
  sudo node ufw-ip-updater.js [command] [options]

Commands:
  start     Start the daemon in background (releases terminal)
  stop      Stop the running daemon
  status    Show daemon status and current IP
  restart   Stop and restart the daemon
  run       Run directly in foreground (useful for systemd/debugging)
  help      Show this help message

Options:
  --foreground, -f   Run in foreground when used with 'start'

Files:
  ${CONFIG.stateFile}  - Stores the last known IP address
  ${CONFIG.logFile}    - Log file for all operations
  ${CONFIG.pidFile}    - Process ID file

Features:
  • Multi-port support (ports: ${CONFIG.portsDisplay})
  • Detached background daemon execution
  • Automatic 5-minute update intervals
  • Log rotation (${CONFIG.maxLogSize / 1024 / 1024}MB max, ${CONFIG.maxLogFiles} files)
  • Graceful shutdown handling
  • Duplicate instance prevention
  • Comprehensive error handling

Note: Start command requires sudo privileges to modify UFW rules.
                `);
                break;
                
            default:
                console.error(`Unknown command: ${command}`);
                console.error('Use "help" to see available commands');
                process.exit(1);
        }
    } catch (error) {
        console.error('Script failed:', error.message);
        process.exit(1);
    }
}

// Run the main function
if (require.main === module) {
    main();
}

module.exports = UFWIPUpdater;