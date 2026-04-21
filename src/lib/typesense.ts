import type { Bindings } from "../env";

interface TypesenseHitDocument {
  id: string;
  content: string;
  type: string;
}

interface TypesenseTagSearchResponse {
  hits?: Array<{
    document: TypesenseHitDocument;
  }>;
}

interface TypesenseSearchResponse<TDocument = Record<string, unknown>> {
  found?: number;
  hits?: Array<{
    document: TDocument;
  }>;
}

export function getTypesenseBaseUrl(env: Bindings): string | null {
  if (!env.TYPESENSE_HOST || !env.TYPESENSE_API_KEY) {
    return null;
  }

  const protocol = env.TYPESENSE_PROTOCOL || "https";
  const port = env.TYPESENSE_PORT || "8108";
  return `${protocol}://${env.TYPESENSE_HOST}:${port}`;
}

function getCollectionName(env: Bindings) {
  return env.TYPESENSE_COLLECTION || "musics";
}

async function typesenseFetch(
  env: Bindings,
  path: string,
  init?: RequestInit,
) {
  const baseUrl = getTypesenseBaseUrl(env);
  if (!baseUrl) {
    throw new Error("Typesense is not configured");
  }

  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      "X-TYPESENSE-API-KEY": env.TYPESENSE_API_KEY as string,
      ...(init?.headers || {}),
    },
  });

  return response;
}

export async function searchTagsInTypesense(
  env: Bindings,
  query: string,
  types: string[] | undefined,
  limit: number,
): Promise<Array<{ id: string; content: string; type: string }> | null> {
  const baseUrl = getTypesenseBaseUrl(env);
  if (!baseUrl) {
    return null;
  }

  const collection = env.TYPESENSE_TAGS_COLLECTION || "tags";
  const url = new URL(`${baseUrl}/collections/${collection}/documents/search`);
  url.searchParams.set("q", query);
  url.searchParams.set("query_by", "content");
  url.searchParams.set("per_page", String(limit));
  url.searchParams.set("num_typos", "1");
  url.searchParams.set("prefix", "true");
  url.searchParams.set("prioritize_exact_match", "true");

  if (types && types.length > 0) {
    const filter = `type:=[${types.map((type) => `\`${type}\``).join(",")}]`;
    url.searchParams.set("filter_by", filter);
  }

  const response = await fetch(url, {
    headers: {
      "X-TYPESENSE-API-KEY": env.TYPESENSE_API_KEY as string,
    },
  });

  if (!response.ok) {
    throw new Error(`Typesense request failed: ${response.status}`);
  }

  const payload = (await response.json()) as TypesenseTagSearchResponse;
  return (payload.hits || []).map((hit) => ({
    id: hit.document.id,
    content: hit.document.content,
    type: hit.document.type,
  }));
}

export async function getTypesenseHealth(env: Bindings) {
  const response = await typesenseFetch(env, "/health");
  if (!response.ok) {
    throw new Error(`Typesense health request failed: ${response.status}`);
  }
  return response.json();
}

export async function getTypesenseCollectionInfo(env: Bindings) {
  const collection = getCollectionName(env);
  const response = await typesenseFetch(env, `/collections/${collection}`);
  if (!response.ok) {
    throw new Error(`Typesense collection request failed: ${response.status}`);
  }
  return response.json();
}

export async function searchTypesenseDocuments<TDocument = Record<string, unknown>>(
  env: Bindings,
  params: Record<string, string | number | boolean>,
): Promise<TypesenseSearchResponse<TDocument>> {
  const collection = getCollectionName(env);
  const url = new URL(`http://typesense.local/collections/${collection}/documents/search`);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, String(value));
  }

  const response = await typesenseFetch(env, `${url.pathname}${url.search}`);
  if (!response.ok) {
    throw new Error(`Typesense search request failed: ${response.status}`);
  }
  return response.json() as Promise<TypesenseSearchResponse<TDocument>>;
}

export async function importTypesenseDocuments(
  env: Bindings,
  documents: Array<Record<string, unknown>>,
  action: "create" | "upsert" | "update" | "emplace" = "upsert",
) {
  const collection = getCollectionName(env);
  const jsonl = documents.map((document) => JSON.stringify(document)).join("\n");
  const response = await typesenseFetch(
    env,
    `/collections/${collection}/documents/import?action=${action}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "text/plain",
      },
      body: jsonl,
    },
  );

  if (!response.ok) {
    throw new Error(`Typesense import request failed: ${response.status}`);
  }

  const text = await response.text();
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { success?: boolean; id?: string; error?: string });
}

export async function deleteTypesenseDocument(env: Bindings, id: string) {
  const collection = getCollectionName(env);
  const response = await typesenseFetch(env, `/collections/${collection}/documents/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });

  if (response.status === 404) {
    return { found: false };
  }
  if (!response.ok) {
    throw new Error(`Typesense delete request failed: ${response.status}`);
  }
  return { found: true };
}
