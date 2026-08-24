import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const GATEWAY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

function pythonChildEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PYTHONUTF8: "1",
    PYTHONIOENCODING: "utf-8",
  };
}

function psQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export interface FasterWhisperExecInput {
  pythonBin: string;
  scriptPath: string;
  repoRoot: string;
  audioRelativePath: string;
  model: string;
  device: string;
  computeType: string;
  beamSize: number;
  bestOf: number;
  temperature: number;
  noSpeechThreshold: number;
  language?: string;
  initialPrompt?: string;
  noVadFilter?: boolean;
  conditionOnPreviousText?: boolean;
  cwd?: string;
  maxBuffer?: number;
}

function buildWindowsRunnerScript(input: FasterWhisperExecInput): string {
  const audioRelative = input.audioRelativePath.replace(/\\/g, "/");
  const languageArg = input.language?.trim()
    ? ` --language ${psQuote(input.language.trim())}`
    : "";
  const promptArg = input.initialPrompt?.trim()
    ? ` --initial-prompt ${psQuote(input.initialPrompt.trim())}`
    : "";
  const conditionArg = input.conditionOnPreviousText ? " --condition-on-previous-text" : "";
  const vadArg = input.noVadFilter === false ? "" : " --no-vad-filter";

  return `$ErrorActionPreference = "SilentlyContinue"
$py = ${psQuote(input.pythonBin)}
$root = ${psQuote(path.resolve(input.repoRoot))}
$audio = Join-Path $root ${psQuote(audioRelative)}
$script = Join-Path $root "scripts/faster-whisper-transcribe.py"
$line = & $py $script --audio $audio --model ${psQuote(input.model)} --device ${psQuote(input.device)} --compute-type ${psQuote(input.computeType)} --beam-size ${psQuote(String(input.beamSize))} --best-of ${psQuote(String(input.bestOf))} --temperature ${psQuote(String(input.temperature))} --no-speech-threshold ${psQuote(String(input.noSpeechThreshold))}${vadArg}${conditionArg}${languageArg}${promptArg} 2>$null | Select-Object -Last 1
Write-Output $line
`;
}

export async function execFasterWhisperScript(
  input: FasterWhisperExecInput,
): Promise<{ stdout: string; stderr: string }> {
  const maxBuffer = input.maxBuffer ?? 10 * 1024 * 1024;
  const env = pythonChildEnv();

  if (process.platform === "win32") {
    const runnerPath = path.join(GATEWAY_ROOT, "scripts", `.mf-stt-run-${randomUUID()}.ps1`);
    const scriptBody = buildWindowsRunnerScript(input);
    await fs.writeFile(runnerPath, scriptBody, "utf8");
    if (process.env.STT_DEBUG_RUNNER === "1") {
      await fs.writeFile(path.join(GATEWAY_ROOT, "scripts", "debug-generated.ps1"), scriptBody, "utf8");
    }
    try {
      const { stdout, stderr } = await execFileAsync(
        "powershell.exe",
        ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", runnerPath],
        { maxBuffer, cwd: input.repoRoot, env },
      );
      return { stdout, stderr };
    } finally {
      await fs.unlink(runnerPath).catch(() => {});
    }
  }

  const audioPath = path.resolve(input.repoRoot, input.audioRelativePath);
  const args = [
    "--audio",
    audioPath,
    "--model",
    input.model,
    "--device",
    input.device,
    "--compute-type",
    input.computeType,
    "--beam-size",
    String(input.beamSize),
    "--best-of",
    String(input.bestOf),
    "--temperature",
    String(input.temperature),
    "--no-speech-threshold",
    String(input.noSpeechThreshold),
    ...(input.noVadFilter === false ? [] : ["--no-vad-filter"]),
    ...(input.conditionOnPreviousText ? ["--condition-on-previous-text"] : []),
    ...(input.language?.trim() ? ["--language", input.language.trim()] : []),
    ...(input.initialPrompt?.trim() ? ["--initial-prompt", input.initialPrompt.trim()] : []),
  ];
  const { stdout, stderr } = await execFileAsync(
    input.pythonBin,
    [input.scriptPath, ...args],
    { maxBuffer, cwd: input.cwd, env },
  );
  return { stdout, stderr };
}

export async function execPythonScript(input: {
  pythonBin: string;
  scriptPath: string;
  args: string[];
  cwd?: string;
  maxBuffer?: number;
}): Promise<{ stdout: string; stderr: string }> {
  const maxBuffer = input.maxBuffer ?? 10 * 1024 * 1024;
  const env = pythonChildEnv();
  const { stdout, stderr } = await execFileAsync(
    input.pythonBin,
    [input.scriptPath, ...input.args],
    { maxBuffer, cwd: input.cwd, env },
  );
  return { stdout, stderr };
}
