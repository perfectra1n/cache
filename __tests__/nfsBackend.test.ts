import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as core from "@actions/core";
import { resetRetryConfig } from "../src/custom/retryConfig";

jest.mock("@actions/core");

import * as nfsBackend from "../src/custom/nfsBackend";

describe("nfsBackend", () => {
    const originalEnv = process.env;
    let tmpDir: string;

    beforeEach(async () => {
        jest.clearAllMocks();
        resetRetryConfig();
        tmpDir = await fs.promises.mkdtemp(
            path.join(os.tmpdir(), "nfs-cache-test-")
        );
        process.env = {
            ...originalEnv,
            RUNS_ON_NFS_CACHE_PATH: tmpDir,
            GITHUB_REPOSITORY: "owner/repo",
            RETRY_BACKOFF_BASE_MS: "1",
            RETRY_BACKOFF_MAX_MS: "10"
        };
        (core.getInput as jest.Mock).mockReturnValue("");
    });

    afterEach(async () => {
        process.env = originalEnv;
        resetRetryConfig();
        await fs.promises.rm(tmpDir, { recursive: true, force: true });
    });

    function cacheDir(version: string): string {
        return path.join(tmpDir, "cache", "owner/repo", version);
    }

    // Helper: create a file in the cache dir structure
    async function writeCacheFile(
        version: string,
        name: string,
        content = "cached-data"
    ): Promise<string> {
        const dir = cacheDir(version);
        await fs.promises.mkdir(dir, { recursive: true });
        const filePath = path.join(dir, name);
        await fs.promises.writeFile(filePath, content);
        return filePath;
    }

    describe("getCacheEntry", () => {
        it("returns the matching cache entry by prefix", async () => {
            // getCacheVersion is deterministic given the same inputs
            const { getCacheVersion } = require("../src/custom/backend");
            const version = getCacheVersion(["/tmp/path"], undefined, false);
            await writeCacheFile(version, "my-cache-key");

            const result = await nfsBackend.getCacheEntry(
                ["my-cache-key"],
                ["/tmp/path"],
                {
                    compressionMethod: undefined,
                    enableCrossOsArchive: false
                }
            );

            expect(result.cacheKey).toBe("my-cache-key");
            expect(result.archiveLocation).toMatch(/^nfs:\/\//);
            expect(result.archiveLocation).toContain("my-cache-key");
        });

        it("returns the most recent file when multiple match", async () => {
            const { getCacheVersion } = require("../src/custom/backend");
            const version = getCacheVersion(["/tmp/path"], undefined, false);

            const olderPath = await writeCacheFile(
                version,
                "my-key-old",
                "old"
            );
            // Ensure different mtime
            const pastTime = new Date(Date.now() - 10000);
            await fs.promises.utimes(olderPath, pastTime, pastTime);

            await writeCacheFile(version, "my-key-new", "new");

            const result = await nfsBackend.getCacheEntry(
                ["my-key"],
                ["/tmp/path"],
                {
                    compressionMethod: undefined,
                    enableCrossOsArchive: false
                }
            );

            expect(result.cacheKey).toBe("my-key-new");
        });

        it("returns empty entry when directory does not exist", async () => {
            const result = await nfsBackend.getCacheEntry(
                ["nonexistent"],
                ["/tmp/path"],
                {
                    compressionMethod: undefined,
                    enableCrossOsArchive: false
                }
            );

            expect(result.cacheKey).toBeUndefined();
            expect(result.archiveLocation).toBeUndefined();
        });

        it("filters out .sha256 sidecar files", async () => {
            const { getCacheVersion } = require("../src/custom/backend");
            const version = getCacheVersion(["/tmp/path"], undefined, false);
            await writeCacheFile(version, "my-key");
            await writeCacheFile(version, "my-key.sha256", "abc123");

            const result = await nfsBackend.getCacheEntry(
                ["my-key"],
                ["/tmp/path"],
                {
                    compressionMethod: undefined,
                    enableCrossOsArchive: false
                }
            );

            expect(result.cacheKey).toBe("my-key");
        });

        it("filters out .tmp files", async () => {
            const { getCacheVersion } = require("../src/custom/backend");
            const version = getCacheVersion(["/tmp/path"], undefined, false);
            await writeCacheFile(version, "my-key.tmp.12345");

            const result = await nfsBackend.getCacheEntry(
                ["my-key"],
                ["/tmp/path"],
                {
                    compressionMethod: undefined,
                    enableCrossOsArchive: false
                }
            );

            expect(result.cacheKey).toBeUndefined();
        });

        it("tries restore keys in order", async () => {
            const { getCacheVersion } = require("../src/custom/backend");
            const version = getCacheVersion(["/tmp/path"], undefined, false);
            await writeCacheFile(version, "fallback-key");

            const result = await nfsBackend.getCacheEntry(
                ["primary-key", "fallback-key"],
                ["/tmp/path"],
                {
                    compressionMethod: undefined,
                    enableCrossOsArchive: false
                }
            );

            expect(result.cacheKey).toBe("fallback-key");
        });
    });

    describe("downloadCache", () => {
        it("copies file from NFS to local path", async () => {
            const sourceDir = path.join(tmpDir, "source");
            await fs.promises.mkdir(sourceDir, { recursive: true });
            const sourcePath = path.join(sourceDir, "archive.tar");
            await fs.promises.writeFile(sourcePath, "archive-content");

            const destPath = path.join(tmpDir, "local-archive.tar");

            await nfsBackend.downloadCache(
                `nfs://${sourcePath}`,
                destPath
            );

            const content = await fs.promises.readFile(destPath, "utf-8");
            expect(content).toBe("archive-content");
        });

        it("validates SHA-256 when sidecar file exists", async () => {
            const sourceDir = path.join(tmpDir, "source");
            await fs.promises.mkdir(sourceDir, { recursive: true });
            const sourcePath = path.join(sourceDir, "archive.tar");
            const content = "archive-content";
            await fs.promises.writeFile(sourcePath, content);

            // Compute correct SHA-256
            const crypto = require("crypto");
            const sha256 = crypto
                .createHash("sha256")
                .update(content)
                .digest("hex");
            await fs.promises.writeFile(`${sourcePath}.sha256`, sha256);

            const destPath = path.join(tmpDir, "local-archive.tar");

            await nfsBackend.downloadCache(
                `nfs://${sourcePath}`,
                destPath
            );

            expect(core.info).toHaveBeenCalledWith(
                "Download integrity verified (SHA-256 match)"
            );
        });

        it("throws on SHA-256 mismatch", async () => {
            const sourceDir = path.join(tmpDir, "source");
            await fs.promises.mkdir(sourceDir, { recursive: true });
            const sourcePath = path.join(sourceDir, "archive.tar");
            await fs.promises.writeFile(sourcePath, "archive-content");
            await fs.promises.writeFile(
                `${sourcePath}.sha256`,
                "badhash000"
            );

            const destPath = path.join(tmpDir, "local-archive.tar");

            await expect(
                nfsBackend.downloadCache(`nfs://${sourcePath}`, destPath)
            ).rejects.toThrow("Download integrity failed");
        });

        it("skips integrity check when sidecar is missing", async () => {
            const sourceDir = path.join(tmpDir, "source");
            await fs.promises.mkdir(sourceDir, { recursive: true });
            const sourcePath = path.join(sourceDir, "archive.tar");
            await fs.promises.writeFile(sourcePath, "archive-content");

            const destPath = path.join(tmpDir, "local-archive.tar");

            await nfsBackend.downloadCache(
                `nfs://${sourcePath}`,
                destPath
            );

            const destContent = await fs.promises.readFile(destPath, "utf-8");
            expect(destContent).toBe("archive-content");
        });
    });

    describe("saveCache", () => {
        it("creates directory and saves cache file with sidecar", async () => {
            const { getCacheVersion } = require("../src/custom/backend");
            const version = getCacheVersion(["/tmp/path"], undefined, false);

            // Create a temp archive file
            const archivePath = path.join(tmpDir, "archive.tar");
            await fs.promises.writeFile(archivePath, "test-archive-data");

            await nfsBackend.saveCache(
                "test-key",
                ["/tmp/path"],
                archivePath,
                {
                    compressionMethod: undefined,
                    enableCrossOsArchive: false,
                    cacheSize: 0
                }
            );

            const destDir = cacheDir(version);
            const destPath = path.join(destDir, "test-key");
            const sha256Path = path.join(destDir, "test-key.sha256");

            // Verify the cache file was written
            const content = await fs.promises.readFile(destPath, "utf-8");
            expect(content).toBe("test-archive-data");

            // Verify sidecar SHA-256 file was written
            const sha256Content = await fs.promises.readFile(
                sha256Path,
                "utf-8"
            );
            expect(sha256Content).toHaveLength(64); // SHA-256 hex length
        });

        it("creates nested directories", async () => {
            const archivePath = path.join(tmpDir, "archive.tar");
            await fs.promises.writeFile(archivePath, "data");

            // This should succeed even though the directory doesn't exist yet
            await nfsBackend.saveCache(
                "my-key",
                ["/tmp/path"],
                archivePath,
                {
                    compressionMethod: undefined,
                    enableCrossOsArchive: false,
                    cacheSize: 0
                }
            );

            expect(core.info).toHaveBeenCalledWith(
                "Cache saved successfully."
            );
        });

        it("uses atomic write pattern (temp file + rename)", async () => {
            const archivePath = path.join(tmpDir, "archive.tar");
            await fs.promises.writeFile(archivePath, "data");

            // After save, there should be no .tmp files left
            const { getCacheVersion } = require("../src/custom/backend");
            const version = getCacheVersion(["/tmp/path"], undefined, false);

            await nfsBackend.saveCache(
                "my-key",
                ["/tmp/path"],
                archivePath,
                {
                    compressionMethod: undefined,
                    enableCrossOsArchive: false,
                    cacheSize: 0
                }
            );

            const destDir = cacheDir(version);
            const files = await fs.promises.readdir(destDir);
            const tmpFiles = files.filter(f => f.includes(".tmp"));
            expect(tmpFiles).toHaveLength(0);
        });
    });
});
