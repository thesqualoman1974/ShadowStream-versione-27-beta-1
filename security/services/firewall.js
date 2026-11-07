const { execFile } = require('child_process');
const config = require('../config');

const RULE_NAME_PREFIX = 'ShadowStream-Ban-steam_';
const simulatedRules = new Map();
const ruleOperations = new Map();

function withRuleLock(steamHex, operation) {
    const previous = ruleOperations.get(steamHex) || Promise.resolve();
    const current = previous.catch(() => {}).then(operation);
    ruleOperations.set(steamHex, current);
    return current.finally(() => {
        if (ruleOperations.get(steamHex) === current) ruleOperations.delete(steamHex);
    });
}

function runPowerShell(script, environment = {}) {
    if (config.testMode) {
        const ruleName = environment.SHADOWSTREAM_RULE_NAME;
        if (script.includes('Write-Output "CREATED"')) {
            if (simulatedRules.has(ruleName)) return Promise.resolve('PRESENT');
            simulatedRules.set(ruleName, environment.SHADOWSTREAM_REMOTE_ADDRESS);
            return Promise.resolve('CREATED');
        }
        simulatedRules.delete(ruleName);
        return Promise.resolve('');
    }

    return new Promise((resolve, reject) => {
        execFile('powershell.exe', [
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            script
        ], {
            windowsHide: true,
            env: { ...process.env, ...environment },
            timeout: 15_000,
            maxBuffer: 1024 * 1024
        }, (error, stdout) => {
            if (error) return reject(error);
            resolve(stdout.trim());
        });
    });
}

async function ensureRuleUnlocked(steamHex, remoteAddress) {
    const ruleName = `${RULE_NAME_PREFIX}${steamHex}`;
    return runPowerShell(
        '$ruleName = $env:SHADOWSTREAM_RULE_NAME; $expectedAddress = $env:SHADOWSTREAM_REMOTE_ADDRESS; $rules = @(Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -ceq $ruleName }); $valid = $false; foreach ($rule in $rules) { $filter = $rule | Get-NetFirewallAddressFilter; if ($rule.Direction -eq "Outbound" -and $rule.Action -eq "Block" -and $rule.Enabled -eq "True" -and @($filter.RemoteAddress) -contains $expectedAddress) { $valid = $true } }; if ($rules.Count -ne 1 -or -not $valid) { $rules | Remove-NetFirewallRule -ErrorAction Stop; New-NetFirewallRule -DisplayName $ruleName -Direction Outbound -RemoteAddress $expectedAddress -Action Block -ErrorAction Stop | Out-Null; Write-Output "CREATED" } else { Write-Output "PRESENT" }',
        { SHADOWSTREAM_RULE_NAME: ruleName, SHADOWSTREAM_REMOTE_ADDRESS: remoteAddress }
    ).then(output => output === 'CREATED');
}

function removeRuleUnlocked(steamHex) {
    return runPowerShell(
        '$ruleName = $env:SHADOWSTREAM_RULE_NAME; @(Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -ceq $ruleName }) | Remove-NetFirewallRule -ErrorAction Stop',
        { SHADOWSTREAM_RULE_NAME: `${RULE_NAME_PREFIX}${steamHex}` }
    );
}

function ensureRule(steamHex, remoteAddress) {
    return withRuleLock(steamHex, () => ensureRuleUnlocked(steamHex, remoteAddress));
}

function removeRule(steamHex) {
    return withRuleLock(steamHex, () => removeRuleUnlocked(steamHex));
}

module.exports = {
    ensureRule,
    ensureRuleUnlocked,
    removeRule,
    removeRuleUnlocked,
    withRuleLock
};
