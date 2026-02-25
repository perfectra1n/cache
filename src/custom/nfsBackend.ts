import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import * as core from "@actions/core";
import * as utils from "@actions/cache/lib/internal/cacheUtils";
import { CompressionMethod } from "@actions/cache/lib/internal/constants";
import { getCacheVersion, ArtifactCacheEntry } from "./backend";
import { withRetry, isTransientError } from "./retry";

function getNfsCachePath(): string {
    return process.env["RUNS_ON_NFS_CACHE_PATH"] || "";
}

// S3 keys are flat strings — "/" is just a character, not a directory separator.
// On a filesystem "/" creates subdirectories, breaking readdir-based lookups.
// Replace "/" with "-" to keep all cache files in a single flat directory.
function sanitizeKey(key: string): string {
    return key.replace(/\//g, "-");
}

function getNfsPrefix(
    paths: string[],
    { compressionMethod, enableCrossOsArchive }
): string {
    const repository = process.env.GITHUB_REPOSITORY;
    const version = getCacheVersion(
        paths,
        compressionMethod,
        enableCrossOsArchive
    );

    return path.join(getNfsCachePath(), "cache", repository || "", version);
}

export async function getCacheEntry(
    keys,
    paths,
    { compressionMethod, enableCrossOsArchive }
) {
    const cacheEntry: ArtifactCacheEntry = {};

    for (const restoreKey of keys) {
        const dirPath = getNfsPrefix(paths, {
            compressionMethod,
            enableCrossOsArchive
        });

        try {
            let entries: fs.Dirent[];
            try {
                entries = await fs.promises.readdir(dirPath, {
                    withFileTypes: true
                });
            } catch (err: any) {
                if (err.code === "ENOENT") {
                    continue;
                }
                throw err;
            }

            // Filter to files matching the prefix, excluding .sha256 sidecar and .tmp files
            const safeKey = sanitizeKey(restoreKey);
            const matching = entries.filter(
                e =>
                    e.isFile() &&
                    e.name.startsWith(safeKey) &&
                    !e.name.endsWith(".sha256") &&
                    !e.name.includes(".tmp")
            );

            if (matching.length === 0) {
                continue;
            }

            // Get stats and sort by mtime descending to find the most recent
            const withStats = await Promise.all(
                matching.map(async e => {
                    const fullPath = path.join(dirPath, e.name);
                    const stat = await fs.promises.stat(fullPath);
                    return { name: e.name, fullPath, mtime: stat.mtimeMs };
                })
            );

            withStats.sort((a, b) => b.mtime - a.mtime);

            const best = withStats[0];
            cacheEntry.cacheKey = best.name;
            cacheEntry.archiveLocation = `nfs://${best.fullPath}`;
            return cacheEntry;
        } catch (error) {
            console.error(
                `Error listing files with prefix ${restoreKey} in ${dirPath}:`,
                error
            );
        }
    }

    return cacheEntry;
}

export async function downloadCache(
    archiveLocation: string,
    archivePath: string
): Promise<void> {
    // Parse nfs:// location to get the source path
    const sourcePath = archiveLocation.replace(/^nfs:\/\//, "");

    // Read expected SHA-256 upfront (if sidecar exists) so we can validate
    // during the copy instead of re-reading the entire file afterwards.
    let expectedSha256: string | undefined;
    const sha256Path = `${sourcePath}.sha256`;
    try {
        expectedSha256 = (
            await fs.promises.readFile(sha256Path, "utf-8")
        ).trim();
    } catch (err: any) {
        if (err.code !== "ENOENT") {
            throw err;
        }
        core.debug(
            "No SHA-256 sidecar file found, skipping integrity check"
        );
    }

    await withRetry(
        async () => {
            if (expectedSha256) {
                // Stream copy + SHA-256 in a single pass to avoid reading
                // the file twice (copyFile + computeFileSha256 separately
                // would double the I/O through the NFS mount).
                core.info("Verifying download integrity (SHA-256)...");
                const actualSha256 = await copyFileWithSha256(
                    sourcePath,
                    archivePath
                );
                if (actualSha256 !== expectedSha256) {
                    throw new Error(
                        `Download integrity failed: expected SHA-256 ${expectedSha256} but computed ${actualSha256}`
                    );
                }
                core.info("Download integrity verified (SHA-256 match)");
            } else {
                await fs.promises.copyFile(sourcePath, archivePath);
            }
        },
        {
            isRetryable: isTransientError,
            label: "nfsDownloadCache"
        }
    );
}

export async function saveCache(
    key: string,
    paths: string[],
    archivePath: string,
    { compressionMethod, enableCrossOsArchive, cacheSize: archiveFileSize }
): Promise<void> {
    const dirPath = getNfsPrefix(paths, {
        compressionMethod,
        enableCrossOsArchive
    });
    const safeKey = sanitizeKey(key);
    const destPath = path.join(dirPath, safeKey);
    const tmpPath = `${destPath}.tmp.${process.pid}`;

    const cacheSize = utils.getArchiveFileSizeInBytes(archivePath);
    core.info(
        `Cache Size: ~${Math.round(
            cacheSize / (1024 * 1024)
        )} MB (${cacheSize} B)`
    );

    // Compute SHA-256 of archive
    core.info("Computing archive SHA-256...");
    const archiveSha256 = await computeFileSha256(archivePath);
    core.info(`Archive SHA-256: ${archiveSha256}`);

    core.info(`Saving cache to ${destPath}`);

    await withRetry(
        async () => {
            // Ensure destination directory exists
            await fs.promises.mkdir(dirPath, { recursive: true });

            // Atomic write: copy to temp file then rename
            await fs.promises.copyFile(archivePath, tmpPath);
            await fs.promises.rename(tmpPath, destPath);

            // Write SHA-256 sidecar file
            await fs.promises.writeFile(`${destPath}.sha256`, archiveSha256);
        },
        {
            isRetryable: isTransientError,
            label: "nfsSaveCache"
        }
    );

    core.info(`Cache saved successfully.`);
}

function computeFileSha256(filePath: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash("sha256");
        const stream = fs.createReadStream(filePath);
        stream.on("data", data => hash.update(data));
        stream.on("end", () => resolve(hash.digest("hex")));
        stream.on("error", reject);
    });
}

/**
 * Copy a file while computing its SHA-256 in a single pass.
 * Returns the hex-encoded hash of the copied data.
 */
function copyFileWithSha256(
    sourcePath: string,
    destPath: string
): Promise<string> {
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash("sha256");
        const readStream = fs.createReadStream(sourcePath);
        const writeStream = fs.createWriteStream(destPath);

        readStream.on("data", (chunk: Buffer) => {
            hash.update(chunk);
        });

        readStream.on("error", err => {
            writeStream.destroy();
            reject(err);
        });

        writeStream.on("error", err => {
            readStream.destroy();
            reject(err);
        });

        writeStream.on("finish", () => {
            resolve(hash.digest("hex"));
        });

        readStream.pipe(writeStream);
    });
}
