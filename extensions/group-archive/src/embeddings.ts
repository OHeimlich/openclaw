import OpenAI from "openai";

export class EmbeddingClient {
  private client: OpenAI;
  private model: string;

  constructor(apiKey: string, model: string) {
    this.client = new OpenAI({ apiKey });
    this.model = model;
  }

  async embed(text: string): Promise<number[]> {
    const trimmed = text.slice(0, 8000);
    const response = await this.client.embeddings.create({
      model: this.model,
      input: trimmed,
    });
    const vec = response.data[0]?.embedding;
    if (!vec) throw new Error("OpenAI embeddings returned empty data");
    return vec;
  }
}
