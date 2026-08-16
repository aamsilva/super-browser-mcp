# Machine Learning
> 发布时间: 2026-08-15T18:06:57.796Z
> 原文链接: https://www.reddit.com/r/MachineLearning/hot/

---

Repost [How can we solve long-range recall in linear attention? \[D\]](https://www.reddit.com/r/MachineLearning/comments/1vpqwdc/how_can_we_solve_longrange_recall_in_linear/) [![u/No-Coffee-8227 avatar](images/img_001.png)u/No-Coffee-8227](https://www.reddit.com/user/No-Coffee-8227/)• 14 min. ago

[How can we solve long-range recall in linear attention? \[D\]](https://www.reddit.com/r/MachineLearning/comments/1vpqwdc/how_can_we_solve_longrange_recall_in_linear/)[

Discussion

](https://www.reddit.com/r/MachineLearning/?f=flair_name%3A%22Discussion%22)[

Recently, I started working on DNA sequence modeling and decided to explore **linear attention**, mainly because DNA sequences can easily reach **1M tokens**, making standard softmax attention extremely expensive in terms of memory and computation.

The model performed reasonably well on several benchmarks, but I ran into a major problem with **long-range recall**. On a Needle in a Haystack-style benchmark, my model was performing around **25% or even below**, which is essentially random chance for a four-token DNA vocabulary (A/C/G/T).

I initially thought this might just be a problem with my implementation or model architecture, so I started looking into existing approaches for improving recall in linear attention. Most of what I found relied on **external memory, sliding/recent-token mechanisms, or hybrid architectures combining linear and softmax attention**.

I also tried **HyenaDNA** on the same needle benchmark, and surprisingly, it also performed poorly getting around **25–27%**. So this doesn't seem to be limited to my particular linear-attention implementation.

What's even more confusing is that when I tested a **very small linear-attention model at only 16K context**, it achieved around **50–60% recall**. But as the context gets longer, the recall problem becomes much more severe.

I've also experimented with modifying the linear architecture to improve recall, but the improvement was only around **27%**, which is still basically chance.

So I'm wondering:

**What are the actual ways to solve long-range recall in linear attention, especially for DNA sequences?**

Is this fundamentally a limitation of the compressed-state representation used by linear attention, or are there architectural approaches that can preserve reliable retrieval without falling back to expensive softmax attention or a large external memory?

I'm particularly interested in approaches that can scale to **million-token DNA sequences**.

](https://www.reddit.com/r/MachineLearning/comments/1vpqwdc/how_can_we_solve_longrange_recall_in_linear/)