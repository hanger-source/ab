import type { BenchmarkDoctorCheck, CommandResult } from "./types.ts";

export async function ensureDockerSystem(): Promise<CommandResult> {
  const status = await runCommand(["colima", "status"]);
  if (status.exitCode !== 0) {
    const colima = await runVisibleCommand([
      "colima",
      "start",
      "--runtime",
      "docker",
      "--vm-type",
      "vz",
      "--cpus",
      process.env.AB_COLIMA_CPUS ?? "6",
      "--memory",
      process.env.AB_COLIMA_MEMORY_GIB ?? "10",
      "--disk",
      process.env.AB_COLIMA_DISK_GIB ?? "60",
    ]);
    if (colima.exitCode !== 0) return colima;
  }
  const context = await runCommand(["docker", "context", "use", "colima"]);
  if (context.exitCode !== 0) return context;
  const emulation = await ensureQemuAmd64Emulation();
  if (emulation.exitCode !== 0) return emulation;
  return runCommand(["docker", "info", "--format", "{{.ServerVersion}}"]);
}

export async function ensureRosettaSupervisorService(
  containerName: string,
  serviceName: string,
  readyUrl: string,
  options: { attempts?: number; intervalMs?: number } = {},
): Promise<CommandResult> {
  const initial = await dockerExecHttpCheck(containerName, readyUrl);
  if (initial.exitCode === 0) return initial;

  const rosetta = await setAmd64Emulation("rosetta");
  if (rosetta.exitCode !== 0) return rosetta;

  try {
    const restart = await runCommand([
      "docker",
      "exec",
      containerName,
      "supervisorctl",
      "restart",
      serviceName,
    ]);
    if (restart.exitCode !== 0) return restart;

    const attempts = options.attempts ?? 24;
    const intervalMs = options.intervalMs ?? 5_000;
    let last = initial;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      last = await dockerExecHttpCheck(containerName, readyUrl);
      if (last.exitCode === 0) return last;
      if (attempt + 1 < attempts) await Bun.sleep(intervalMs);
    }
    return last;
  } finally {
    const qemu = await setAmd64Emulation("qemu");
    if (qemu.exitCode !== 0) {
      throw new Error(`failed to restore QEMU amd64 emulation: ${qemu.stderr || qemu.stdout}`);
    }
  }
}

export function dockerContainerHttpCheck(
  name: string,
  containerName: string,
  url: string,
): BenchmarkDoctorCheck {
  const result = Bun.spawnSync([
    "docker",
    "exec",
    containerName,
    "curl",
    "--max-time",
    "3",
    "--fail",
    "--silent",
    "--show-error",
    url,
  ], { stdout: "pipe", stderr: "pipe" });
  return result.exitCode === 0
    ? { name, status: "ready", detail: `${containerName} ${url}` }
    : {
      name,
      status: "blocked",
      detail: (result.stderr.toString() || result.stdout.toString()).trim() || `${containerName} is unavailable`,
    };
}

export function dockerSystemCheck(): BenchmarkDoctorCheck {
  const context = Bun.spawnSync(["docker", "context", "show"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const result = Bun.spawnSync(["docker", "info", "--format", "{{.ServerVersion}}"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const qemu = Bun.spawnSync([
    "colima",
    "ssh",
    "--",
    "cat",
    "/proc/sys/fs/binfmt_misc/qemu-x86_64",
  ], { stdout: "pipe", stderr: "pipe" });
  const rosetta = Bun.spawnSync([
    "colima",
    "ssh",
    "--",
    "cat",
    "/proc/sys/fs/binfmt_misc/rosetta",
  ], { stdout: "pipe", stderr: "pipe" });
  const contextName = context.stdout.toString().trim();
  const qemuEnabled = qemu.exitCode === 0 && qemu.stdout.toString().startsWith("enabled\n");
  const rosettaDisabled = rosetta.exitCode !== 0 || rosetta.stdout.toString().startsWith("disabled\n");
  return result.exitCode === 0 && contextName === "colima" && qemuEnabled && rosettaDisabled
    ? {
      name: "Colima Docker runtime",
      status: "ready",
      detail: `context=${contextName} server=${result.stdout.toString().trim()} amd64=qemu`,
    }
    : {
      name: "Colima Docker runtime",
      status: "blocked",
      detail: [
        `context=${contextName || "unavailable"}`,
        `server=${(result.stderr.toString() || result.stdout.toString()).trim() || "unavailable"}`,
        `qemu=${qemuEnabled ? "enabled" : "unavailable"}`,
        `rosetta=${rosettaDisabled ? "disabled" : "enabled"}`,
      ].join(" "),
    };
}

async function ensureQemuAmd64Emulation(): Promise<CommandResult> {
  return setAmd64Emulation("qemu");
}

async function setAmd64Emulation(mode: "qemu" | "rosetta"): Promise<CommandResult> {
  const script = mode === "rosetta"
    ? `test -e /proc/sys/fs/binfmt_misc/rosetta
echo 0 > /proc/sys/fs/binfmt_misc/qemu-x86_64
echo 1 > /proc/sys/fs/binfmt_misc/rosetta`
    : `if [ -e /proc/sys/fs/binfmt_misc/rosetta ]; then
  echo 0 > /proc/sys/fs/binfmt_misc/rosetta
fi
echo 1 > /proc/sys/fs/binfmt_misc/qemu-x86_64`;
  return runCommand([
    "colima",
    "ssh",
    "--",
    "sudo",
    "sh",
    "-eu",
    "-c",
    script,
  ]);
}

function dockerExecHttpCheck(containerName: string, url: string): Promise<CommandResult> {
  return runCommand([
    "docker",
    "exec",
    containerName,
    "curl",
    "--max-time",
    "3",
    "--fail",
    "--silent",
    "--show-error",
    url,
  ]);
}

export async function dockerContainerExists(name: string): Promise<boolean> {
  return (await runCommand(["docker", "container", "inspect", name])).exitCode === 0;
}

export async function dockerNetworkExists(name: string): Promise<boolean> {
  return (await runCommand(["docker", "network", "inspect", name])).exitCode === 0;
}

export async function replaceDockerContainer(name: string): Promise<void> {
  if (!await dockerContainerExists(name)) return;
  const result = await runCommand(["docker", "container", "rm", "--force", name]);
  if (result.exitCode !== 0) {
    throw new Error(`failed to replace Docker container ${name}: ${result.stderr || result.stdout}`);
  }
}

export async function ensureDockerNetwork(name: string): Promise<void> {
  if (await dockerNetworkExists(name)) return;
  const result = await runCommand(["docker", "network", "create", name]);
  if (result.exitCode !== 0) {
    throw new Error(`failed to create Docker network ${name}: ${result.stderr || result.stdout}`);
  }
}

export async function pullDockerImage(image: string, platform: string): Promise<void> {
  const inspected = await runCommand([
    "docker",
    "image",
    "inspect",
    "--format",
    "{{.Os}}/{{.Architecture}}",
    image,
  ]);
  if (inspected.exitCode === 0 && inspected.stdout.trim() === platform) return;
  const result = await runVisibleCommand(["docker", "image", "pull", "--platform", platform, image]);
  if (result.exitCode !== 0) {
    throw new Error(`failed to pull ${image} with Colima Docker: ${result.stderr || result.stdout}`);
  }
}

export async function runCommand(command: string[]): Promise<CommandResult> {
  const process = Bun.spawn(command, { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  return { command, exitCode, stdout, stderr };
}

async function runVisibleCommand(command: string[]): Promise<CommandResult> {
  const process = Bun.spawn(command, { stdout: "inherit", stderr: "inherit" });
  const exitCode = await process.exited;
  return { command, exitCode, stdout: "", stderr: "" };
}
