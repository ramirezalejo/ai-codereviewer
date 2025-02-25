import { readFileSync } from "fs";
import * as core from "@actions/core";
import OpenAI from "openai";
import { Octokit } from "@octokit/rest";
import parseDiff, { Chunk, File, Change } from "parse-diff";
import minimatch from "minimatch";

const GITHUB_TOKEN: string = core.getInput("GITHUB_TOKEN");
const OPENAI_API_KEY: string = core.getInput("OPENAI_API_KEY");
const OPENAI_API_MODEL: string = core.getInput("OPENAI_API_MODEL");
const MAX_FILES: number = core.getInput("MAX_FILES") ? parseInt(core.getInput("MAX_FILES")) : 20;
const MAX_TOKENS: number = core.getInput("MAX_TOKENS") ? parseInt(core.getInput("MAX_TOKENS")) : 4096;

const octokit = new Octokit({ auth: GITHUB_TOKEN });

const openai = new OpenAI({
  apiKey: OPENAI_API_KEY,
});

interface PRDetails {
  owner: string;
  repo: string;
  pull_number: number;
  title: string;
  description: string;
}

async function getPRDetails(): Promise<PRDetails> {
  const { repository, number } = JSON.parse(
    readFileSync(process.env.GITHUB_EVENT_PATH || "", "utf8")
  );
  const prResponse = await octokit.pulls.get({
    owner: repository.owner.login,
    repo: repository.name,
    pull_number: number,
  });
  return {
    owner: repository.owner.login,
    repo: repository.name,
    pull_number: number,
    title: prResponse.data.title ?? "",
    description: prResponse.data.body ?? "",
  };
}

async function getDiff(
  owner: string,
  repo: string,
  pull_number: number
): Promise<string | null> {
  try {
    const response = await octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', {
      owner,
      repo,
      pull_number,
      mediaType: {
        format: 'diff',
      },
    });
    return response.data as unknown as string;
  } catch (error) {
    console.error('Error fetching diff:', error);
    return null;
  }
}

function getLanguageContext(filename: string): string {
  if (filename.endsWith('.cs')) {
    return `This is a C# file using .NET 8 features. Consider the following when reviewing:
- C# 12 features like primary constructors, collection expressions, and inline arrays
- .NET 8 features including native AOT compilation considerations
- Performance implications and best practices
- Dependency injection patterns
- Async/await usage
- SOLID principles
- Nullable reference types
- Record types and pattern matching
- Memory management and disposable resources`;
  }
  return '';
}

async function analyzeCode(
  parsedDiff: File[],
  prDetails: PRDetails
): Promise<Array<{ body: string; path: string; line: number }>> {
  const comments: Array<{ body: string; path: string; line: number }> = [];

  // If there are more than MAX_FILES, only process the first MAX_FILES
  const filesToProcess = parsedDiff.length > MAX_FILES 
    ? parsedDiff.slice(0, MAX_FILES) 
    : parsedDiff;

  if (parsedDiff.length > MAX_FILES) {
    console.log(`Pull request contains ${parsedDiff.length} files. Processing only the first ${MAX_FILES} files.`);
  }

  for (const file of filesToProcess) {
    if (file.to === "/dev/null") continue; // Ignore deleted files
    for (const chunk of file.chunks) {
      const prompt = createPrompt(file, chunk, prDetails);
      const aiResponse = await getAIResponse(prompt);
      if (aiResponse) {
        const newComments = createComment(file, chunk, aiResponse);
        if (newComments) {
          comments.push(...newComments);
        }
      }
    }
  }
  return comments;
}

function createPrompt(file: File, chunk: Chunk, prDetails: PRDetails): string {
  const languageContext = getLanguageContext(file.to || '');
  
  return `Your task is to review pull requests. Instructions:
- Provide the response in following JSON format:  {"reviews": [{"lineNumber":  <line_number>, "reviewComment": "<review comment>"}]}
- Do not give positive comments or compliments.
- Provide comments and suggestions ONLY if there is something to improve, otherwise "reviews" should be an empty array.
- Write the comment in GitHub Markdown format.
- Use the given description only for the overall context and only comment the code.
- IMPORTANT: NEVER suggest adding comments to the code.
- IMPORTANT: NEVER suggest to add a newline at the end of the file to follow the standard coding conventions.

${languageContext}

Review the following code diff in the file "${
    file.to
  }" and take the pull request title and description into account when writing the response.
  
Pull request title: ${prDetails.title}
Pull request description:

---
${prDetails.description}
---

Git diff to review:

\`\`\`diff
${chunk.content}
${chunk.changes
  .map((c: Change) => `${c.ln ? c.ln : c.ln2} ${c.content}`)
  .join("\n")}
\`\`\`
`;
}

// Rough estimation of tokens (4 chars ~= 1 token)
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

async function getAIResponse(prompt: string): Promise<Array<{
  lineNumber: string;
  reviewComment: string;
}> | null> {
  // Estimate prompt tokens and ensure we don't exceed model limits
  const estimatedPromptTokens = estimateTokens(prompt);
  const maxResponseTokens = 700;
  
  // If prompt is too long, truncate it while keeping essential parts
  if (estimatedPromptTokens + maxResponseTokens > MAX_TOKENS) {
    const allowedPromptTokens = MAX_TOKENS - maxResponseTokens;
    const truncateAt = allowedPromptTokens * 4; // Convert back to characters
    
    // Keep the beginning instructions and truncate the diff part
    const parts = prompt.split("Git diff to review:");
    if (parts.length === 2) {
      const truncatedDiff = parts[1].slice(-truncateAt);
      prompt = parts[0] + "Git diff to review:" + truncatedDiff;
    }
  }

  const queryConfig = {
    model: OPENAI_API_MODEL,
    temperature: 0.2,
    max_completion_tokens: maxResponseTokens,
    top_p: 1,
    frequency_penalty: 0,
    presence_penalty: 0,
  };

  try {
    const response = await openai.chat.completions.create({
      ...queryConfig,
      // return JSON if the model supports it:
      ...(OPENAI_API_MODEL === "gpt-4-1106-preview"
        ? { response_format: { type: "json_object" } }
        : {}),
      messages: [
        {
          role: "system",
          content: prompt,
        },
      ],
    });

    const res = response.choices[0].message?.content?.trim() || "{}";
    return JSON.parse(res).reviews;
  } catch (error) {
    console.error("Error:", error);
    return null;
  }
}

function createComment(
  file: File,
  chunk: Chunk,
  aiResponses: Array<{
    lineNumber: string;
    reviewComment: string;
  }>
): Array<{ body: string; path: string; line: number }> {
  return aiResponses.flatMap((aiResponse) => {
    if (!file.to) {
      return [];
    }
    return {
      body: aiResponse.reviewComment,
      path: file.to,
      line: Number(aiResponse.lineNumber),
    };
  });
}

async function createReviewComment(
  owner: string,
  repo: string,
  pull_number: number,
  comments: Array<{ body: string; path: string; line: number }>
): Promise<void> {
  await octokit.pulls.createReview({
    owner,
    repo,
    pull_number,
    comments,
    event: "COMMENT",
  });
}

async function main() {
  const prDetails = await getPRDetails();
  let diff: string | null;
  const eventData = JSON.parse(
    readFileSync(process.env.GITHUB_EVENT_PATH ?? "", "utf8")
  );

  if (eventData.action === "opened") {
    diff = await getDiff(
      prDetails.owner,
      prDetails.repo,
      prDetails.pull_number
    );
  } else if (eventData.action === "synchronize") {
    const newBaseSha = eventData.before;
    const newHeadSha = eventData.after;

    const response = await octokit.repos.compareCommits({
      headers: {
        accept: "application/vnd.github.v3.diff",
      },
      owner: prDetails.owner,
      repo: prDetails.repo,
      base: newBaseSha,
      head: newHeadSha,
    });

    diff = String(response.data);
  } else {
    console.log("Unsupported event:", process.env.GITHUB_EVENT_NAME);
    return;
  }

  if (!diff) {
    console.log("No diff found");
    return;
  }

  const parsedDiff = parseDiff(diff);

  const excludePatterns = core
    .getInput("exclude")
    .split(",")
    .map((s: string) => s.trim());

  const filteredDiff = parsedDiff.filter((file: File) => {
    return !excludePatterns.some((pattern: string) =>
      minimatch(file.to ?? "", pattern)
    );
  });

  const comments = await analyzeCode(filteredDiff, prDetails);
  if (comments.length > 0) {
    await createReviewComment(
      prDetails.owner,
      prDetails.repo,
      prDetails.pull_number,
      comments
    );
  }
}

main().catch((error) => {
  console.error("Error:", error);
  process.exit(1);
});
