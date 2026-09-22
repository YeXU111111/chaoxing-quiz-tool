/*!
 * sample.js —— 内置示例题库
 *
 * 目的只有一个：让刷题站第一次打开不是一片空白，
 * 用户能立刻看懂「一道题长什么样、错题本怎么用、背题模式是什么」。
 * 生产使用中没有任何代码依赖它，删掉不影响功能。
 *
 * 内容就是计算机网络的基础题，答案均为教材通用结论。
 */
(function (global) {
  'use strict';

  var bg = 'https://mooc1.chaoxing.com/mooc-ans/work/doWork';

  function q(type, index, stem, options, answer, analysis) {
    return {
      type: type,
      index: index,
      stem: stem,
      options: options || [],
      answerRaw: answer,
      analysis: analysis || '',
      hasAnswer: true
    };
  }

  var BANKS = [
    {
      id: 'demo::course-net::work-1',
      courseId: 'demo-course-net',
      courseName: '计算机网络',
      workId: 'demo-work-1',
      workTitle: '第 1 章 概述 · 课后作业',
      kind: 'work',
      sourceUrl: bg,
      questions: [
        q('single', 1, '在 OSI 参考模型中，负责在相邻结点之间提供无差错的帧传输的是哪一层？',
          ['物理层', '数据链路层', '网络层', '传输层'], 'B',
          '数据链路层的核心任务是把物理层收到的比特流组织成帧，并通过 CRC、序号、重传等手段实现相邻结点间的可靠传输。网络层负责的是端到端（跨越多个网络）的交付。'),

        q('single', 2, '下列哪个协议工作在传输层，并提供面向连接的可靠传输服务？',
          ['UDP', 'IP', 'TCP', 'ICMP'], 'C',
          'TCP 面向连接、提供可靠交付；UDP 虽然也在传输层，但是无连接的；IP 在网络层；ICMP 是网络层的差错报告协议。'),

        q('multiple', 3, '下列哪些属于分组交换相对电路交换的优点？',
          ['线路利用率高', '传输时延固定且有保证', '支持不同速率的终端之间通信', '网络故障时生存性强'], 'ACD',
          '电路交换独占线路，时延固定可预测，这是它的优点；分组交换是「尽力而为」，时延抖动反而更大。所以 B 项描述的是电路交换的特点。'),

        q('judge', 4, '在 TCP/IP 体系结构中，网络接口层既包含物理层也包含数据链路层的功能。',
          ['对', '错'], 'A',
          'TCP/IP 的网络接口层对应 OSI 的物理层 + 数据链路层，这一层不规定具体协议，由底层网络自己决定，体现的是 TCP/IP「兼容一切底层网络」的设计思想。'),

        q('judge', 5, 'IP 协议提供的是可靠交付服务。',
          ['对', '错'], 'B',
          'IP 提供的是「尽最大努力交付」(best-effort)，不保证不丢失、不保证按序到达。可靠性必须由上层（如 TCP）来补。'),

        q('fill', 6, 'OSI 参考模型共分为 ______ 层，其中最高层是 ______ 层。',
          [], '第一空：7 第二空：应用',
          'OSI 是七层模型：物理、数据链路、网络、传输、会话、表示、应用。TCP/IP 通常按四层（网络接口、网际、传输、应用）理解。'),

        q('fill', 7, '在计算机网络中，把「主机之间交换数据的规则集合」称为 ______。',
          [], '协议',
          '协议包含三要素：语法（数据格式）、语义（做什么动作）、同步（动作的先后顺序）。'),

        q('single', 8, 'ping 命令使用的协议是？',
          ['ARP', 'ICMP', 'TCP', 'DNS'], 'B',
          'ping 通过发送 ICMP Echo Request 并等待 Echo Reply 来测试连通性，它工作在网际层。')
      ]
    },
    {
      id: 'demo::course-net::work-2',
      courseId: 'demo-course-net',
      courseName: '计算机网络',
      workId: 'demo-work-2',
      workTitle: '第 2 章 物理层 · 课后作业',
      kind: 'work',
      sourceUrl: bg,
      questions: [
        q('single', 1, '在常用的传输介质中，带宽最宽、抗电磁干扰能力最强的是？',
          ['双绞线', '同轴电缆', '光纤', '无线电波'], 'C',
          '光纤靠光信号传输，不受电磁干扰影响，且可用带宽远高于铜介质。缺点是不易弯折、接口成本较高。'),

        q('single', 2, '数据通信中，波特率指的是？',
          ['每秒传输的比特数', '每秒传输的码元数', '信号的最大频率', '信道的带宽'], 'B',
          '波特率（Baud）是码元传输速率，单位是「码元/秒」。比特率 = 波特率 × 每码元携带的比特数，两者在四进制调制下并不相等。'),

        q('multiple', 3, '关于香农公式 C = W·log₂(1 + S/N)，下列说法正确的有？',
          ['C 是信道的极限信息传输速率', 'W 是信道带宽', 'S/N 是信噪比', '只要增加带宽就能无限提高传输速率'], 'ABC',
          '香农公式给出的是理论极限。虽然带宽越大 C 越大，但实际中带宽增加会同时引入更多噪声，且硬件实现有上限，D 项是典型误解。'),

        q('judge', 4, '曼彻斯特编码的优点是自带同步信息，缺点是编码效率只有 50%。',
          ['对', '错'], 'A',
          '曼彻斯特编码在每个码元中间强制跳变，接收方可以直接从跳变中提取时钟，因此不需要额外的同步信号；代价是每个码元需要两个信号周期，效率减半。'),

        q('judge', 5, '数字信号在光纤中传输时不存在衰减。',
          ['对', '错'], 'B',
          '光纤也有衰减，只是比铜缆小得多，且衰减主要来自材料吸收、散射和接头损耗，所以长距离传输依然需要中继器或光放大器。'),

        q('fill', 6, '在数据通信中，常用 ______ 来衡量信道质量，其单位是分贝（dB）。',
          [], '信噪比',
          '信噪比 = 信号平均功率 / 噪声平均功率，常用 10lg(S/N) 以分贝表示。它是香农公式的关键输入。'),

        q('single', 7, '基带传输与频带传输的区别在于？',
          ['是否使用调制', '是否使用双绞线', '是否使用数字信号', '传输距离的远近'], 'A',
          '基带传输直接把数字信号送上线路（如常见的以太网）；频带传输则先把数字信号调制到载波上再传输（如 ADSL、Wi-Fi）。核心区别是有无调制。')
      ]
    },

    // 第二个学科。留着它是为了让「学科」筛选一打开就能看出效果 ——
    // 只有一门课时，分类功能等于不存在。
    {
      id: 'demo::course-en::work-1',
      courseId: 'demo-course-en',
      courseName: '大学英语',
      workId: 'demo-work-en-1',
      workTitle: 'Unit 1 词汇与语法',
      kind: 'work',
      sourceUrl: bg,
      questions: [
        q('single', 1, 'He ______ to the library every Sunday morning.',
          ['go', 'goes', 'going', 'gone'], 'B',
          '主语是第三人称单数 he，一般现在时的动词要加 -s。every Sunday morning 是典型的一般现在时时间状语。'),

        q('single', 2, 'The report ______ by the end of last week.',
          ['finished', 'was finished', 'has finished', 'is finishing'], 'B',
          'by the end of last week 指向过去完成时的时间点，且 report 是被完成的，用过去完成时的被动语态。'),

        q('judge', 3, '“advice” 是可数名词，可以说 an advice。',
          ['对', '错'], 'B',
          'advice 是不可数名词，不能加不定冠词。要计数得用 a piece of advice。'),

        q('fill', 4, 'She is good ______ solving difficult problems.',
          [], 'at',
          'be good at 是固定搭配，at 后接名词或动名词。')
      ]
    }
  ];

  // 章节信息在真实抓取里来自页面面包屑，示例里手动补上
  BANKS[0].questions.forEach(function (q) { q.chapter = '第 1 章 概述'; });
  BANKS[1].questions.forEach(function (q) { q.chapter = '第 2 章 物理层'; });
  BANKS[2].questions.forEach(function (q) { q.chapter = 'Unit 1 Vocabulary'; });

  global.CQB_SAMPLE_BANKS = BANKS;
})(window);
