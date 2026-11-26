import type { Source } from '../src/shared/production';

export const SOURCES: Source[] = [
  {
    id: 'S1',
    title: 'Large language model',
    url: 'https://en.wikipedia.org/wiki/Large_language_model',
    publisher: 'Wikipedia',
    retrievedAt: '2026-11-26T00:00:00Z',
    excerpt:
      'A large language model (LLM) is a language model trained with self-supervised machine learning on a vast amount of text. ' +
      'The largest and most capable LLMs are generative pre-trained transformers. ' +
      'They can be fine-tuned for specific tasks or guided by prompt engineering. ' +
      'These models acquire predictive power regarding syntax, semantics, and ontologies inherent in human language corpora.'
  },
  {
    id: 'S2',
    title: 'Transformer (deep learning architecture)',
    url: 'https://en.wikipedia.org/wiki/Transformer_(deep_learning_architecture)',
    publisher: 'Wikipedia',
    retrievedAt: '2026-11-26T00:00:00Z',
    excerpt:
      'The transformer is a deep learning architecture based on the multi-head attention mechanism. ' +
      'Text is converted to numerical representations called tokens, and each token is converted into a vector. ' +
      'Transformers have the advantage of having no recurrent units, and therefore require less training time than earlier recurrent neural architectures.'
  }
];
