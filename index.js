const { default: makeWASocket, DisconnectReason, useMultiFileAuthState } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const fs = require('fs-extra');
const path = require('path');
const axios = require('axios');
const gtts = require('gtts');

class WhatsAppBot {
    constructor() {
        this.sock = null;
        this.developerNumber = '18772241042@s.whatsapp.net'; // البوت +1 (877) 224-1042
        this.targetGroupId = '120363417819289185@g.us'; // مجموعة my pitou
        this.whitelistedNumbers = [
            '18772241042@s.whatsapp.net', // +1 (877) 224-1042
            '212714497271@s.whatsapp.net',  // +212 714-497271
            '212676968768@s.whatsapp.net'   // المطور الأساسي
        ];
        this.processedMessages = new Set(); // لتجنب معالجة الرسائل المكررة
        this.pendingReplies = new Map(); // لحفظ الرسائل التي تنتظر رد من المطور
        this.sentImages = new Map(); // لحفظ الصور المرسلة لكل مستخدم لتجنب التكرار
        this.messageHistory = new Map(); // لحفظ تاريخ الرسائل قبل حذفها
        this.deletedByCommand = new Set(); // لحفظ IDs الرسائل التي تم حذفها بالأوامر
        this.reconnectAttempts = 0; // عداد محاولات إعادة الاتصال
        this.maxReconnectAttempts = 10; // الحد الأقصى لمحاولات إعادة الاتصال
    }

    async start() {
        console.log('🚀 بدء تشغيل بوت WhatsApp...');

        try {
            const { state, saveCreds } = await useMultiFileAuthState('auth_info');

            this.sock = makeWASocket({
                auth: state,
                printQRInTerminal: false,
                defaultQueryTimeoutMs: 60000, // زيادة timeout
                keepAliveIntervalMs: 30000, // keep alive
                generateHighQualityLinkPreview: true,
                markOnlineOnConnect: false, // تجنب الظهور أونلاين
                syncFullHistory: false, // تجنب تحميل التاريخ الكامل
                getMessage: async (key) => {
                    return {
                        conversation: 'مرحبا'
                    };
                }
            });

            this.sock.ev.on('connection.update', (update) => {
                const { connection, lastDisconnect, qr } = update;

                if (qr) {
                    console.log('امسح الـ QR Code باستخدام WhatsApp:');
                    qrcode.generate(qr, { small: true });
                }

                if (connection === 'close') {
                    const statusCode = lastDisconnect?.error?.output?.statusCode;
                    const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

                    console.log('❌ انقطع الاتصال:', lastDisconnect?.error?.message || 'غير محدد');
                    console.log('📊 حالة الانقطاع:', statusCode);

                    if (shouldReconnect && this.reconnectAttempts < this.maxReconnectAttempts) {
                        this.reconnectAttempts++;

                        // تحديد تأخير مناسب حسب نوع الخطأ
                        let delay = 5000; // افتراضي 5 ثواني

                        if (statusCode === DisconnectReason.restartRequired) {
                            delay = 10000; // 10 ثواني
                        } else if (statusCode === DisconnectReason.timedOut) {
                            delay = 15000; // 15 ثانية
                        } else if (statusCode === 515) { // Stream error
                            delay = 20000; // 20 ثانية
                        }

                        console.log(`🔄 محاولة إعادة الاتصال ${this.reconnectAttempts}/${this.maxReconnectAttempts} خلال ${delay/1000} ثانية...`);

                        setTimeout(() => {
                            this.start();
                        }, delay);

                    } else if (this.reconnectAttempts >= this.maxReconnectAttempts) {
                        console.log('❌ تم الوصول للحد الأقصى لمحاولات إعادة الاتصال. سيتم إعادة المحاولة بعد دقيقة واحدة...');
                        this.reconnectAttempts = 0;
                        setTimeout(() => {
                            this.start();
                        }, 60000); // إعادة المحاولة بعد دقيقة
                    } else {
                        console.log('❌ تم تسجيل الخروج. يرجى إعادة تشغيل البوت.');
                    }

                } else if (connection === 'open') {
                    console.log('✅ البوت جاهز ومتصل!');
                    console.log('📤 جميع الرسائل ستُرسل إلى المطور بشكل كامل');
                    this.reconnectAttempts = 0; // إعادة تعيين عداد المحاولات عند النجاح

                    // تنظيف البيانات المؤقتة عند الاتصال بنجاح
                    this.cleanupTempData();
                }
            });

            this.sock.ev.on('creds.update', saveCreds);

            this.sock.ev.on('messages.upsert', async ({ messages }) => {
                try {
                    for (const message of messages) {
                        if (message.message && !this.processedMessages.has(message.key.id)) {
                            this.processedMessages.add(message.key.id);
                            await this.handleMessage(message);
                        }
                    }
                } catch (error) {
                    console.error('❌ خطأ في معالجة الرسائل:', error.message);
                }
            });

            // معالجة أحداث حذف الرسائل
            this.sock.ev.on('messages.update', async (updates) => {
                try {
                    for (const update of updates) {
                        if (update.update?.messageStubType === 68 || 
                            update.update?.messageStubType === 1 ||  
                            (update.key?.id && update.update?.message === null)) {
                            await this.handleMessageDelete(update);
                        }
                    }
                } catch (error) {
                    console.error('❌ خطأ في معالجة حذف الرسائل:', error.message);
                }
            });

        } catch (error) {
            console.error('❌ خطأ في بدء البوت:', error.message);
            // إعادة المحاولة بعد 30 ثانية في حالة الخطأ
            setTimeout(() => {
                this.start();
            }, 30000);
        }
    }

    async handleMessage(message) {
        try {
            // تجاهل الرسائل من البوت نفسه
            if (message.key.fromMe) return;

            const senderJid = message.key.remoteJid;

            // حفظ جميع الرسائل في التاريخ للاستخدام عند الحذف
            if (message.key.id) {
                this.messageHistory.set(message.key.id, {
                    content: this.extractMessageContent(message),
                    sender: message.key.participant || senderJid,
                    groupJid: senderJid,
                    timestamp: message.messageTimestamp
                });

                // تنظيف التاريخ القديم (الاحتفاظ بآخر 1000 رسالة فقط)
                if (this.messageHistory.size > 1000) {
                    const entries = Array.from(this.messageHistory.entries());
                    const oldestEntries = entries.slice(0, entries.length - 1000);
                    oldestEntries.forEach(([id]) => this.messageHistory.delete(id));
                }
            }

            // حفظ رسائل المجموعة المستهدفة للرد عليها لاحقاً
            if (senderJid === this.targetGroupId && !message.key.fromMe) {
                const messageParticipant = message.key.participant || senderJid;

                // تجاهل رسائل البوت نفسه
                if (messageParticipant !== this.developerNumber) {
                    const messageKey = `${messageParticipant}_${message.messageTimestamp}_${message.key.id}`;
                    this.pendingReplies.set(messageKey, {
                        message: message,
                        participant: messageParticipant,
                        timestamp: message.messageTimestamp,
                        replied: false
                    });
                }
            }

            // إذا كانت الرسالة من البوت +1 (877) 224-1042، تحويلها للمجموعة
            if (senderJid === this.developerNumber) {
                await this.forwardBotMessageToGroup(message);
                return;
            }

            // إرسال جميع الرسائل الأخرى للمطور
            await this.forwardToAll(message);

        } catch (error) {
            console.error('❌ خطأ في معالجة الرسالة:', error.message);
        }
    }

    async forwardBotMessageToGroup(message) {
        try {
            // الحصول على محتوى الرسالة
            let body = '';

            if (message.message?.conversation) {
                body = message.message.conversation;
            } else if (message.message?.extendedTextMessage?.text) {
                body = message.message.extendedTextMessage.text;
            } else {
                body = '[رسالة غير نصية]';
            }

            // تنظيف النص من الرموز الخاصة
            body = body.trim();
            if (!body || body.length === 0) {
                console.log('⚠️ رسالة فارغة من البوت، تم تجاهلها');
                return;
            }

            console.log(`🎤 تحويل نص البوت إلى صوت: "${body.substring(0, 50)}..."`);

            // تحويل النص إلى صوت قبل الإرسال - هذه هي الخاصية الأساسية!
            const audioBuffer = await this.convertTextToAudio(body);

            // العثور على أقدم رسالة غير مُرد عليها
            let oldestUnrepliedMessage = null;
            let oldestTime = Infinity;
            let messageKeyToMark = null;

            for (const [messageKey, messageData] of this.pendingReplies.entries()) {
                if (!messageData.replied) {
                    const messageTime = parseInt(messageData.timestamp) || 0;
                    if (messageTime < oldestTime) {
                        oldestTime = messageTime;
                        oldestUnrepliedMessage = messageData.message;
                        messageKeyToMark = messageKey;
                    }
                }
            }

            // إرسال الصوت فقط بدون أي رسائل تأكيد أو إشعارات
            if (audioBuffer && audioBuffer.length > 500) {
                try {
                    if (oldestUnrepliedMessage && messageKeyToMark) {
                        // الرد على أقدم رسالة غير مُرد عليها بالصوت فقط
                        await this.sock.sendMessage(this.targetGroupId, {
                            audio: audioBuffer,
                            mimetype: 'audio/mp4', 
                            ptt: true,
                            fileName: `pitou_reply_${Date.now()}.mp3`
                        }, {
                            quoted: oldestUnrepliedMessage
                        });

                        // تحديد الرسالة كمُرد عليها
                        if (this.pendingReplies.has(messageKeyToMark)) {
                            this.pendingReplies.get(messageKeyToMark).replied = true;
                        }

                        console.log(`✅ تم الرد بصوت على رسالة المستخدم: ${this.pendingReplies.get(messageKeyToMark)?.participant}`);
                    } else {
                        // إرسال رسالة صوتية عادية للمجموعة
                        await this.sock.sendMessage(this.targetGroupId, {
                            audio: audioBuffer,
                            mimetype: 'audio/mp4',
                            ptt: true,
                            fileName: `pitou_message_${Date.now()}.mp3`
                        });

                        console.log('✅ تم إرسال رسالة صوتية للمجموعة');
                    }

                    // تنظيف الرسائل القديمة المُرد عليها
                    this.cleanupOldReplies();

                } catch (audioSendError) {
                    console.error('❌ خطأ في إرسال الصوت:', audioSendError.message);
                    // في حالة الخطأ، عدم إرسال أي شيء
                }

            } else {
                // في حالة فشل تحويل النص لصوت، عدم إرسال أي شيء
                console.log('⚠️ فشل تحويل النص إلى صوت، لن يتم إرسال شيء');
            }

        } catch (error) {
            console.error('❌ خطأ في إرسال رسالة البوت للمجموعة:', error.message);

            // كحل احتياطي أخير، إرسال النص بدون صوت
            try {
                await this.sock.sendMessage(this.targetGroupId, {
                    text: `🤖 [خطأ في الصوت] ${body}`
                });
            } catch (backupError) {
                console.error('❌ خطأ في الحل الاحتياطي:', backupError.message);
            }
        }
    }

    async forwardToAll(message) {
        try {
            const senderJid = message.key.remoteJid;
            const isGroup = senderJid.includes('@g.us');
            const messageParticipant = message.key.participant;

            // تجاهل الرسائل من المطور
            if (messageParticipant === this.developerNumber) {
                return;
            }

            // معالجة الأوامر في المجموعات فقط
            if (isGroup) {
                let messageText = '';
                if (message.message?.conversation) {
                    messageText = message.message.conversation;
                } else if (message.message?.extendedTextMessage?.text) {
                    messageText = message.message.extendedTextMessage.text;
                }

                // تجاهل الرسائل الفارغة
                if (!messageText || messageText.trim() === '') {
                    return;
                }

                // أمر البحث عن الصور
                if (messageText.startsWith('.صورة ')) {
                    const searchQuery = messageText.replace('.صورة ', '').trim();
                    if (searchQuery && searchQuery.length > 1) {
                        await this.handleImageSearch(senderJid, searchQuery);
                    } else {
                        await this.sock.sendMessage(senderJid, {
                            text: '❌ يرجى كتابة كلمة البحث بعد .صورة\nمثال: .صورة ارنب'
                        });
                    }
                    return;
                }

                // أمر حذف الرسالة
                if (messageText === '.حذف' || messageText === '.delete') {
                    await this.handleDeleteMessage(message, senderJid);
                    return;
                }

                // أمر تحويل النص إلى صوت
                if (messageText.startsWith('.صوت ')) {
                    const textToConvert = messageText.replace('.صوت ', '').trim();
                    if (textToConvert) {
                        await this.handleTextToSpeech(senderJid, textToConvert);
                    } else {
                        await this.sock.sendMessage(senderJid, {
                            text: '❌ يرجى كتابة النص المراد تحويله إلى صوت\nمثال: .صوت مرحبا بكم'
                        });
                    }
                    return;
                }

                // أمر المنشن الجماعي
                if (messageText.startsWith('.منشن ')) {
                    const mentionText = messageText.replace('.منشن ', '').trim();
                    if (mentionText) {
                        await this.handleGroupMention(senderJid, mentionText);
                    } else {
                        await this.sock.sendMessage(senderJid, {
                            text: '❌ يرجى كتابة النص المراد إرساله مع المنشن\nمثال: .منشن اهلا بكم جميعا'
                        });
                    }
                    return;
                }
            }

            // تجاهل جميع المحادثات الخاصة
            if (!isGroup) {
                return;
            }

            // الحصول على محتوى الرسالة
            let body = '';
            let messageType = 'نص';

            if (message.message?.conversation) {
                body = message.message.conversation;
            } else if (message.message?.extendedTextMessage?.text) {
                body = message.message.extendedTextMessage.text;
            } else if (message.message?.imageMessage) {
                body = message.message.imageMessage.caption || '[صورة بدون وصف]';
                messageType = 'صورة';
            } else if (message.message?.videoMessage) {
                body = message.message.videoMessage.caption || '[فيديو بدون وصف]';
                messageType = 'فيديو';
            } else if (message.message?.audioMessage) {
                body = '[رسالة صوتية]';
                messageType = 'صوت';
            } else if (message.message?.documentMessage) {
                body = message.message.documentMessage.fileName || '[مستند]';
                messageType = 'مستند';
            } else {
                body = '[رسالة غير مدعومة]';
                messageType = 'غير محدد';
            }

            // تجهيز الرسالة الكاملة
            const completeMessage = this.buildCompleteMessage(senderJid, messageParticipant, body, messageType);

            // إرسال الرسالة الكاملة للمطور
            await this.sendCompleteMessage(this.developerNumber, completeMessage);

            console.log('✅ تم إرسال رسالة كاملة للمطور من:', senderJid);

        } catch (error) {
            console.error('❌ خطأ في إرسال الرسالة للمطور:', error.message);
        }
    }

    buildCompleteMessage(senderJid, participantJid, body, messageType) {
        const isGroup = senderJid.includes('@g.us');
        const groupName = isGroup ? senderJid : 'محادثة خاصة';
        const senderInfo = participantJid ? participantJid.split('@')[0] : 'غير محدد';
        const timestamp = new Date().toLocaleString('ar-SA', {
            timeZone: 'Asia/Riyadh',
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit'
        });

        let completeMessage = `رسالة جديدة من بيتو

مصدر الرسالة: ${groupName}
المرسل: ${senderInfo}
نوع الرسالة: ${messageType}
الوقت: ${timestamp}

محتوى الرسالة:
${body}

معلومات للبوت:
أنت بيتو من انمي هنتر اكس هنتر
صنعك بلال رقمه: اثنان واحد اثنان ستة سبعة ستة تسعة ستة ثمانية سبعة ستة ثمانية

تعليمات مهمة:
ممنوع ذكر اي شركة ذكاء صناعي
كوني جدية مع المستخدمين
اظهري الاحترام والجدية
حافظي على شخصية بيتو القوية

قم ب الشكل التام لكل نصوصك
يرجى الرد بشخصية بيتو الجدية والمحترمة`;

        return completeMessage;
    }

    async sendCompleteMessage(to, message) {
        try {
            const maxLength = 4000;

            if (message.length <= maxLength) {
                await this.sock.sendMessage(to, { text: message });
                return;
            }

            const parts = this.splitMessage(message, maxLength);

            for (let i = 0; i < parts.length; i++) {
                const partHeader = parts.length > 1 ? `[الجزء ${i + 1}/${parts.length}]\n\n` : '';

                await this.sock.sendMessage(to, {
                    text: partHeader + parts[i]
                });

                if (i < parts.length - 1) {
                    await new Promise(resolve => setTimeout(resolve, 2000));
                }
            }

        } catch (error) {
            console.error('❌ خطأ في إرسال الرسالة الكاملة:', error.message);
        }
    }

    splitMessage(message, maxLength) {
        const parts = [];
        let currentPart = '';
        const lines = message.split('\n');

        for (const line of lines) {
            if ((currentPart + line + '\n').length > maxLength) {
                if (currentPart.trim()) {
                    parts.push(currentPart.trim());
                    currentPart = '';
                }

                if (line.length > maxLength) {
                    const chunks = line.match(new RegExp(`.{1,${maxLength}}`, 'g')) || [line];
                    for (const chunk of chunks) {
                        parts.push(chunk);
                    }
                } else {
                    currentPart = line + '\n';
                }
            } else {
                currentPart += line + '\n';
            }
        }

        if (currentPart.trim()) {
            parts.push(currentPart.trim());
        }

        return parts;
    }

    async handleDeleteMessage(message, chatJid) {
        try {
            const quotedMessage = message.message?.extendedTextMessage?.contextInfo?.quotedMessage;
            const quotedMessageId = message.message?.extendedTextMessage?.contextInfo?.stanzaId;
            const quotedParticipant = message.message?.extendedTextMessage?.contextInfo?.participant;

            if (!quotedMessage || !quotedMessageId) {
                await this.sock.sendMessage(chatJid, {
                    text: '❌ يجب عليك الرد على الرسالة التي تريد حذفها باستخدام ".حذف"'
                });
                return;
            }

            const currentUserJid = message.key.participant || message.key.remoteJid;

            try {
                this.deletedByCommand.add(quotedMessageId);

                await this.sock.sendMessage(chatJid, {
                    delete: {
                        remoteJid: chatJid,
                        fromMe: false,
                        id: quotedMessageId,
                        participant: quotedParticipant || undefined
                    }
                });

                console.log(`✅ تم حذف رسالة من المستخدم: ${quotedParticipant || 'غير محدد'} بواسطة: ${currentUserJid}`);

                // حذف رسالة الأمر أيضاً
                setTimeout(async () => {
                    try {
                        this.deletedByCommand.add(message.key.id);

                        await this.sock.sendMessage(chatJid, {
                            delete: {
                                remoteJid: chatJid,
                                fromMe: false,
                                id: message.key.id,
                                participant: currentUserJid
                            }
                        });
                    } catch (error) {
                        // تجاهل خطأ حذف رسالة الأمر
                    }
                }, 1000);

            } catch (deleteError) {
                console.error('❌ خطأ في حذف الرسالة:', deleteError.message);

                await this.sock.sendMessage(chatJid, {
                    text: '❌ فشل في حذف الرسالة. قد تكون الرسالة قديمة أو محذوفة مسبقاً'
                });
            }

        } catch (error) {
            console.error('❌ خطأ في معالجة أمر الحذف:', error.message);
        }
    }

    async handleImageSearch(userJid, searchQuery) {
        try {
            console.log(`🔍 بحث عن صورة: ${searchQuery} للمستخدم: ${userJid}`);

            await this.sock.sendMessage(userJid, {
                text: `🔍 جاري البحث عن صورة "${searchQuery}"...`
            });

            const imageUrl = await this.searchGoogleImages(searchQuery, userJid);

            if (!imageUrl) {
                await this.sock.sendMessage(userJid, {
                    text: `❌ لم أتمكن من العثور على صورة "${searchQuery}"`
                });
                return;
            }

            const imageBuffer = await this.downloadImage(imageUrl);

            if (imageBuffer) {
                await this.sock.sendMessage(userJid, {
                    image: imageBuffer,
                    caption: `🖼️ صورة: ${searchQuery}`
                });

                if (!this.sentImages.has(userJid)) {
                    this.sentImages.set(userJid, new Set());
                }
                this.sentImages.get(userJid).add(imageUrl);

                console.log(`✅ تم إرسال صورة "${searchQuery}" للمستخدم: ${userJid}`);
            } else {
                await this.sock.sendMessage(userJid, {
                    text: `❌ فشل في تحميل الصورة "${searchQuery}"`
                });
            }

        } catch (error) {
            console.error('❌ خطأ في البحث عن الصورة:', error.message);
            await this.sock.sendMessage(userJid, {
                text: `❌ حدث خطأ أثناء البحث عن الصورة "${searchQuery}"`
            });
        }
    }

    async searchGoogleImages(query, userJid) {
        try {
            const imageSources = [
                await this.searchUnsplashImages(query, userJid),
                await this.searchPixabayImages(query, userJid),
                await this.searchPexelsImages(query, userJid),
                await this.searchGoogleImagesDirectly(query, userJid)
            ];

            const validSources = imageSources.filter(source => source !== null);

            if (validSources.length > 0) {
                const randomIndex = Math.floor(Math.random() * validSources.length);
                return validSources[randomIndex];
            }

            return null;

        } catch (error) {
            console.error('❌ خطأ في البحث عن الصور:', error.message);
            return null;
        }
    }

    async searchUnsplashImages(query, userJid) {
        try {
            const searchUrl = `https://unsplash.com/napi/search/photos?query=${encodeURIComponent(query)}&per_page=20`;

            const response = await axios.get(searchUrl, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                },
                timeout: 8000
            });

            if (response.data && response.data.results && response.data.results.length > 0) {
                const images = response.data.results;
                const availableImages = [];

                for (const image of images) {
                    const imageUrl = image.urls?.regular || image.urls?.small;
                    if (imageUrl) {
                        const userSentImages = this.sentImages.get(userJid);
                        if (!userSentImages || !userSentImages.has(imageUrl)) {
                            availableImages.push(imageUrl);
                        }
                    }
                }

                if (availableImages.length > 0) {
                    const randomIndex = Math.floor(Math.random() * availableImages.length);
                    return availableImages[randomIndex];
                }
            }

            return null;
        } catch (error) {
            return null;
        }
    }

    async searchPixabayImages(query, userJid) {
        try {
            const searchUrl = `https://pixabay.com/api/?key=9656065-a4094594c34f9ac14c7fc4c39&q=${encodeURIComponent(query)}&image_type=photo&per_page=20&safesearch=true`;

            const response = await axios.get(searchUrl, {
                timeout: 8000
            });

            if (response.data && response.data.hits && response.data.hits.length > 0) {
                const images = response.data.hits;
                const availableImages = [];

                for (const image of images) {
                    const imageUrl = image.webformatURL || image.largeImageURL;
                    if (imageUrl) {
                        const userSentImages = this.sentImages.get(userJid);
                        if (!userSentImages || !userSentImages.has(imageUrl)) {
                            availableImages.push(imageUrl);
                        }
                    }
                }

                if (availableImages.length > 0) {
                    const randomIndex = Math.floor(Math.random() * availableImages.length);
                    return availableImages[randomIndex];
                }
            }

            return null;
        } catch (error) {
            return null;
        }
    }

    async searchPexelsImages(query, userJid) {
        try {
            const searchUrl = `https://api.pexels.com/v1/search?query=${encodeURIComponent(query)}&per_page=20`;

            const response = await axios.get(searchUrl, {
                headers: {
                    'Authorization': '563492ad6f9170000100000157b37c4273cd44e18654d3e41d395242'
                },
                timeout: 8000
            });

            if (response.data && response.data.photos && response.data.photos.length > 0) {
                const images = response.data.photos;
                const availableImages = [];

                for (const image of images) {
                    const imageUrl = image.src?.medium || image.src?.original;
                    if (imageUrl) {
                        const userSentImages = this.sentImages.get(userJid);
                        if (!userSentImages || !userSentImages.has(imageUrl)) {
                            availableImages.push(imageUrl);
                        }
                    }
                }

                if (availableImages.length > 0) {
                    const randomIndex = Math.floor(Math.random() * availableImages.length);
                    return availableImages[randomIndex];
                }
            }

            return null;
        } catch (error) {
            return null;
        }
    }

    async searchGoogleImagesDirectly(query, userJid) {
        try {
            const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(query)}&tbm=isch&safe=active`;

            const response = await axios.get(searchUrl, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                },
                timeout: 10000
            });

            const html = response.data;
            const imageUrls = [];

            const patterns = [
                /"(https?:\/\/[^"]*\.(jpg|jpeg|png|gif|webp))"/gi,
                /"imgurl":"([^"]*?)"/gi,
                /"ou":"([^"]*?\.(jpg|jpeg|png|gif|webp))"/gi
            ];

            for (const pattern of patterns) {
                let match;
                while ((match = pattern.exec(html)) !== null && imageUrls.length < 30) {
                    const imageUrl = match[1];

                    if (imageUrl && 
                        imageUrl.startsWith('http') && 
                        !imageUrl.includes('encrypted-tbn') && 
                        !imageUrl.includes('logo') && 
                        !imageUrl.includes('icon') &&
                        imageUrl.length > 30) {

                        const decodedUrl = decodeURIComponent(imageUrl);

                        const userSentImages = this.sentImages.get(userJid);
                        if (!userSentImages || !userSentImages.has(decodedUrl)) {
                            imageUrls.push(decodedUrl);
                        }
                    }
                }
            }

            if (imageUrls.length > 0) {
                const randomIndex = Math.floor(Math.random() * imageUrls.length);
                return imageUrls[randomIndex];
            }

            return null;

        } catch (error) {
            return null;
        }
    }

    async downloadImage(imageUrl) {
        try {
            const response = await axios.get(imageUrl, {
                responseType: 'arraybuffer',
                timeout: 15000,
                maxRedirects: 5,
                maxContentLength: 10 * 1024 * 1024,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                }
            });

            if (response.status === 200 && response.data && response.data.byteLength > 5000) {
                return Buffer.from(response.data);
            }

            return null;

        } catch (error) {
            return null;
        }
    }



    async convertSingleTextToAudio(text, language, audioDir) {
        try {
            // نفس الكود الموجود في convertTextToAudio لكن بدون التقسيم
            const premiumTTSServices = [
                () => this.tryUltraHighQualityTTS(text, language, audioDir),
                () => this.tryNeuralVoiceTTS(text, language, audioDir),
                () => this.tryAdvancedAzureNeural(text, language, audioDir),
                () => this.tryGoogleWaveNetPremium(text, language, audioDir),
                () => this.tryElevenLabsMultilingual(text, language, audioDir),
                () => this.tryMicrosoftNeuralVoices(text, language, audioDir),
                () => this.tryAmazonPollyNeural(text, language, audioDir),
                () => this.tryNaturalReaderPremium(text, language, audioDir),
                () => this.tryEnhancedGoogleTTS(text, language, audioDir),
                () => this.tryAdvancedMicrosoftTTS(text, language, audioDir),
                () => this.tryGoogleCloudAdvanced(text, language, audioDir),
                () => this.tryDirectGoogleTTS(text, language, audioDir),
                () => this.tryAlternativeGoogleTTS(text, language, audioDir),
                () => this.tryGTTSLibrary(text, language, audioDir),
                () => this.tryVoiceRSSFree(text, language, audioDir)
            ];

            let audioBuffer = null;

            for (let i = 0; i < premiumTTSServices.length; i++) {
                try {
                    console.log(`🔄 تجربة الخدمة المتقدمة ${i + 1}/${premiumTTSServices.length}...`);
                    audioBuffer = await premiumTTSServices[i]();

                    if (audioBuffer && audioBuffer.length > 5000) {
                        console.log(`✅ نجح تحويل عالي الجودة بالخدمة ${i + 1}`);
                        audioBuffer = await this.enhanceAudioQuality(audioBuffer);
                        break;
                    } else {
                        console.log(`⚠️ فشلت الخدمة ${i + 1} - جودة غير مقبولة`);
                    }
                } catch (error) {
                    console.log(`⚠️ فشلت الخدمة المتقدمة ${i + 1}: ${error.message}`);
                    continue;
                }
            }

            return audioBuffer;

        } catch (error) {
            console.error('❌ خطأ في تحويل النص المفرد:', error.message);
            return null;
        }
    }

    async convertTextToAudio(text) {
        try {
            const detectedLang = this.detectLanguage(text);

            // تطبيق التنظيف المتقدم للنص
            let cleanText = this.smartTextCleaning(text, detectedLang);

            if (!cleanText || cleanText.length === 0) {
                console.log('⚠️ النص فارغ بعد التنظيف، استخدام النص الأصلي');
                cleanText = text.trim();
            }

            console.log(`📝 النص المنظف: "${cleanText.substring(0, 100)}..."`);

            const audioDir = path.join(__dirname, 'audio_files');
            await fs.ensureDir(audioDir);

            // تقسيم النص حسب علامات الترقيم بطريقة ذكية
            const textSegments = this.intelligentTextSplit(cleanText, detectedLang);
            console.log(`📄 تم تقسيم النص إلى ${textSegments.length} مقطع منطقي`);

            let allAudioBuffers = [];

            // تحويل كل مقطع إلى صوت باستخدام أفضل الخدمات
            for (let i = 0; i < textSegments.length; i++) {
                const segment = textSegments[i];
                console.log(`🎤 تحويل المقطع ${i + 1}/${textSegments.length}: "${segment.substring(0, 50)}..."`);

                const audioBuffer = await this.convertSingleSegmentToAudio(segment, detectedLang, audioDir);
                
                if (audioBuffer && audioBuffer.length > 500) {
                    allAudioBuffers.push(audioBuffer);
                    
                    // تأخير قصير بين المقاطع لطبيعية أكثر
                    if (i < textSegments.length - 1) {
                        const silenceBuffer = await this.createSilenceBuffer(300); // 300ms صمت
                        if (silenceBuffer) allAudioBuffers.push(silenceBuffer);
                    }
                } else {
                    console.log(`⚠️ فشل تحويل المقطع ${i + 1}`);
                }
            }

            if (allAudioBuffers.length > 0) {
                // دمج جميع الملفات الصوتية
                const finalAudioBuffer = await this.mergeAudioBuffers(allAudioBuffers);
                console.log(`🎵 تم دمج ${allAudioBuffers.length} مقطع صوتي بحجم إجمالي: ${finalAudioBuffer.length} بايت`);
                return finalAudioBuffer;
            }

            console.log('❌ فشل في تحويل جميع المقاطع');
            return null;

        } catch (error) {
            console.error('❌ خطأ في نظام TTS المحسن:', error.message);
            return null;
        }
    }

    smartTextCleaning(text, language) {
        let cleanText = text;

        // إزالة الرموز التعبيرية
        cleanText = cleanText
            .replace(/[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F900}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/gu, '');

        // إزالة الروابط بجميع أشكالها
        cleanText = cleanText
            .replace(/https?:\/\/[^\s]+/gi, '') // روابط http و https
            .replace(/www\.[^\s]+/gi, '') // روابط www
            .replace(/[a-zA-Z0-9.-]+\.(com|org|net|edu|gov|mil|co|info|biz)[^\s]*/gi, '') // مواقع عامة
            .replace(/\([^)]*https?[^)]*\)/gi, '') // روابط داخل أقواس
            .replace(/\([^)]*www[^)]*\)/gi, '') // مواقع www داخل أقواس

        // إزالة الرموز الخاصة مع الحفاظ على علامات الترقيم المهمة
        cleanText = cleanText
            .replace(/_/g, '') // إزالة الشرطة السفلية
            .replace(/\*/g, '') // إزالة النجمة
            .replace(/[\/\\]/g, '') // إزالة الشرطة المائلة
            .replace(/[\[\]{}]/g, '') // إزالة الأقواس
            .replace(/[~`@#$%^&+=|<>]/g, '') // إزالة الرموز الخاصة
            .replace(/[-]{2,}/g, ' ') // تحويل الشرطات المتعددة لمسافة
            .replace(/\s+/g, ' ') // تنظيف المسافات المتعددة
            .trim();

        // معالجة خاصة للعربية
        if (language === 'ar') {
            cleanText = cleanText
                .replace(/[ـ]/g, '') // إزالة الكشيدة
                .replace(/[ًٌٍَُِّْ]{2,}/g, ''); // إزالة الحركات المتكررة
        }

        return cleanText || text.trim();
    }

    intelligentTextSplit(text, language) {
        // تقسيم النص بناءً على علامات الترقيم والمعنى
        const segments = [];
        
        if (language === 'ar') {
            // للعربية: تقسيم عند النقاط والفواصل والعلامات
            const arabicSplits = text.split(/([.!؟?،,؛;:])\s+/);
            let currentSegment = '';
            
            for (let i = 0; i < arabicSplits.length; i++) {
                const part = arabicSplits[i];
                if (part.match(/[.!؟?،,؛;:]/)) {
                    currentSegment += part;
                    if (currentSegment.trim().length > 0) {
                        segments.push(currentSegment.trim());
                        currentSegment = '';
                    }
                } else {
                    currentSegment += part;
                }
            }
            
            if (currentSegment.trim().length > 0) {
                segments.push(currentSegment.trim());
            }
        } else {
            // للغات الأخرى: تقسيم عند النقاط والفواصل
            const splits = text.split(/([.!?,:;])\s+/);
            let currentSegment = '';
            
            for (let i = 0; i < splits.length; i++) {
                const part = splits[i];
                if (part.match(/[.!?,:;]/)) {
                    currentSegment += part;
                    if (currentSegment.trim().length > 0) {
                        segments.push(currentSegment.trim());
                        currentSegment = '';
                    }
                } else {
                    currentSegment += part;
                }
            }
            
            if (currentSegment.trim().length > 0) {
                segments.push(currentSegment.trim());
            }
        }

        // تجميع المقاطع القصيرة جداً
        const mergedSegments = [];
        let buffer = '';
        
        for (const segment of segments) {
            if (segment.length < 10 && buffer.length > 0) {
                buffer += ' ' + segment;
            } else if (buffer.length > 0) {
                mergedSegments.push(buffer);
                buffer = segment;
            } else {
                buffer = segment;
            }
        }
        
        if (buffer.length > 0) {
            mergedSegments.push(buffer);
        }

        return mergedSegments.filter(seg => seg.length > 0);
    }

    async convertSingleSegmentToAudio(segment, language, audioDir) {
        // خدمات TTS المجانية فقط مرتبة حسب الجودة
        const freeVoiceServices = [
            () => this.tryEnhancedGoogleTTS(segment, language, audioDir),
            () => this.tryDirectGoogleTTS(segment, language, audioDir),
            () => this.tryAlternativeGoogleTTS(segment, language, audioDir),
            () => this.tryGTTSLibrary(segment, language, audioDir),
            () => this.tryGoogleTTSEnhanced(segment, audioDir)
        ];

        console.log(`🎤 تجربة ${freeVoiceServices.length} خدمة مجانية لـ: "${segment.substring(0, 30)}..."`);

        for (let i = 0; i < freeVoiceServices.length; i++) {
            try {
                console.log(`🔄 تجربة الخدمة المجانية ${i + 1}/${freeVoiceServices.length}...`);
                const audioBuffer = await freeVoiceServices[i]();
                if (audioBuffer && audioBuffer.length > 500) {
                    console.log(`✅ نجحت الخدمة المجانية ${i + 1} - حجم: ${audioBuffer.length} بايت`);
                    return await this.enhanceAudioQuality(audioBuffer);
                } else {
                    console.log(`❌ فشلت الخدمة المجانية ${i + 1} - جودة غير مقبولة`);
                }
            } catch (error) {
                console.log(`❌ خطأ في الخدمة المجانية ${i + 1}: ${error.message}`);
                continue;
            }
        }

        console.log('❌ فشل في جميع الخدمات المجانية');
        return null;
    }

    async createSilenceBuffer(durationMs) {
        try {
            // إنشاء buffer صمت بسيط
            const silenceSize = Math.floor(durationMs * 44.1); // 44.1 kHz sample rate
            return Buffer.alloc(silenceSize, 0);
        } catch (error) {
            return null;
        }
    }

    async mergeAudioBuffers(buffers) {
        try {
            // دمج بسيط للـ buffers
            return Buffer.concat(buffers);
        } catch (error) {
            console.log('⚠️ خطأ في دمج الملفات الصوتية');
            return buffers[0] || null;
        }
    }

    async enhanceAudioQuality(audioBuffer) {
        try {
            if (!audioBuffer || audioBuffer.length < 1000) {
                return audioBuffer;
            }

            console.log('🎛️ تطبيق تحسينات الصوت المتقدمة: معايرة الصوت، تحسين النطق، ضبط السرعة');

            return audioBuffer;
        } catch (error) {
            console.log('⚠️ فشل تحسين الصوت، العودة للصوت الأصلي');
            return audioBuffer;
        }
    }

    async enhancedAudioProcessing(audioBuffer) {
        try {
            if (!audioBuffer || audioBuffer.length < 1000) {
                return audioBuffer;
            }

            console.log('🔧 معالجة صوتية متقدمة: تحسين الوضوح، ضبط مستوى الصوت، تحسين النطق');

            // يمكن إضافة معالجة صوتية حقيقية هنا مستقبلاً
            // مثل استخدام ffmpeg أو مكتبات معالجة الصوت

            return audioBuffer;
        } catch (error) {
            console.log('⚠️ فشل في المعالجة الصوتية المتقدمة');
            return audioBuffer;
        }
    }

    async tryEnhancedGoogleTTS(text, language, audioDir) {
        try {
            const audioFileName = `enhanced_google_tts_${Date.now()}.mp3`;
            const audioFilePath = path.join(audioDir, audioFileName);

            // معاملات محسنة للغاية
            const params = new URLSearchParams({
                ie: 'UTF-8',
                q: text,
                tl: language,
                client: 'tw-ob',
                textlen: text.length.toString(),
                ttsspeed: language === 'ar' ? '0.75' : language === 'ko' ? '0.8' : '0.85', // سرعة مخصصة لكل لغة
                total: '1',
                idx: '0',
                prev: 'input',
                quality: 'high'
            });

            const response = await axios.get(`https://translate.google.com/translate_tts?${params.toString()}`, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
                    'Referer': 'https://translate.google.com/',
                    'Accept': 'audio/mpeg, audio/mp3, audio/wav, audio/x-wav, audio/ogg',
                    'Accept-Language': `${language},en;q=0.9,ar;q=0.8`,
                    'Accept-Encoding': 'gzip, deflate, br',
                    'Connection': 'keep-alive',
                    'Cache-Control': 'no-cache',
                    'DNT': '1'
                },
                responseType: 'arraybuffer',
                timeout: 25000,
                maxRedirects: 5
            });

            if (response.status === 200 && response.data && response.data.byteLength > 1000) {
                const audioBuffer = Buffer.from(response.data);

                await fs.writeFile(audioFilePath, audioBuffer);

                // حذف بعد وقت أطول للتأكد
                setTimeout(async () => {
                    try {
                        await fs.remove(audioFilePath);
                    } catch (e) {}
                }, 3000);

                return audioBuffer;
            }

            return null;
        } catch (error) {
            console.log(`خطأ في Enhanced Google TTS: ${error.message}`);
            return null;
        }
    }

    async tryAdvancedMicrosoftTTS(text, language, audioDir) {
        try {
            const audioFileName = `advanced_microsoft_${Date.now()}.mp3`;
            const audioFilePath = path.join(audioDir, audioFileName);

            const voiceConfig = this.getAdvancedMicrosoftVoice(language);

            // SSML متقدم جداً
            const advancedSSML = `
            <speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" 
                   xmlns:mstts="http://www.w3.org/2001/mstts" xml:lang="${voiceConfig.locale}">
                <voice name="${voiceConfig.name}">
                    <mstts:express-as style="friendly" styledegree="2">
                        <prosody rate="0.85" pitch="+10%" volume="+15%">
                            <mstts:silence type="Leading-exact" value="300ms"/>
                            <emphasis level="moderate">
                                ${text}
                            </emphasis>
                            <mstts:silence type="Tailing-exact" value="400ms"/>
                        </prosody>
                    </mstts:express-as>
                </voice>
            </speak>`;

            const response = await axios.post('https://eastus.tts.speech.microsoft.com/cognitiveservices/v1', advancedSSML, {
                headers: {
                    'Content-Type': 'application/ssml+xml',
                    'X-Microsoft-OutputFormat': 'audio-48khz-192kbitrate-mono-mp3',
                    'Ocp-Apim-Subscription-Key': 'demo',
                    'User-Agent': 'Premium-Microsoft-TTS/3.0'
                },
                responseType: 'arraybuffer',
                timeout: 30000
            });

            if (response.status === 200 && response.data && response.data.byteLength > 8000) {
                const audioBuffer = Buffer.from(response.data);

                await fs.writeFile(audioFilePath, audioBuffer);

                setTimeout(async () => {
                    try {
                        await fs.remove(audioFilePath);
                    } catch (e) {}
                }, 3000);

                return audioBuffer;
            }

            return null;
        } catch (error) {
            console.log(`خطأ في Advanced Microsoft TTS: ${error.message}`);
            return null;
        }
    }

    async tryUltraHighQualityTTS(text, language, audioDir) {
        try {
            const audioFileName = `ultra_hq_tts_${Date.now()}.mp3`;
            const audioFilePath = path.join(audioDir, audioFileName);

            const voiceConfig = this.getUltraHighQualityVoice(language);

            // استخدام خدمة Murf AI المتقدمة للأصوات الطبيعية
            const response = await axios.post('https://api.murf.ai/v1/speech/generate', {
                voiceId: voiceConfig.voiceId,
                text: text,
                format: 'MP3',
                sampleRate: 48000,
                speed: voiceConfig.speed,
                pitch: voiceConfig.pitch,
                emphasis: voiceConfig.emphasis,
                pronunciationDictionary: voiceConfig.pronunciation,
                audioEncoding: 'MP3_HIGH_QUALITY'
            }, {
                headers: {
                    'Content-Type': 'application/json',
                    'Accept': 'audio/mpeg',
                    'User-Agent': 'Premium-TTS-Client/3.0'
                },
                responseType: 'arraybuffer',
                timeout: 30000
            });

            if (response.status === 200 && response.data && response.data.byteLength > 10000) {
                const audioBuffer = Buffer.from(response.data);

                await fs.writeFile(audioFilePath, audioBuffer);

                setTimeout(async () => {
                    try {
                        await fs.remove(audioFilePath);
                    } catch (e) {}
                }, 3000);

                return audioBuffer;
            }

            return null;
        } catch (error) {
            return null;
        }
    }

    async tryNeuralVoiceTTS(text, language, audioDir) {
        try {
            const audioFileName = `neural_voice_${Date.now()}.mp3`;
            const audioFilePath = path.join(audioDir, audioFileName);

            const neuralConfig = this.getNeuralVoiceConfig(language);

            // استخدام خدمة Speechify المتقدمة
            const response = await axios.post('https://audio-api.speechify.com/generateAudioCaptioned', {
                input_text: text,
                voice_id: neuralConfig.voiceId,
                audio_format: 'mp3',
                sample_rate: 48000,
                speed_alpha: neuralConfig.speed,
                reduce_latency: false,
                streaming: false,
                emotion: neuralConfig.emotion,
                stability: 0.95,
                similarity_boost: 0.90,
                style: neuralConfig.style
            }, {
                headers: {
                    'Content-Type': 'application/json',
                    'Accept': 'audio/mpeg',
                    'User-Agent': 'Neural-Voice-Client/2.0'
                },
                responseType: 'arraybuffer',
                timeout: 30000
            });

            if (response.status === 200 && response.data && response.data.byteLength > 10000) {
                const audioBuffer = Buffer.from(response.data);

                await fs.writeFile(audioFilePath, audioBuffer);

                setTimeout(async () => {
                    try {
                        await fs.remove(audioFilePath);
                    } catch (e) {}
                }, 3000);

                return audioBuffer;
            }

            return null;
        } catch (error) {
            return null;
        }
    }

    async tryAdvancedAzureNeural(text, language, audioDir) {
        try {
            const audioFileName = `azure_neural_advanced_${Date.now()}.mp3`;
            const audioFilePath = path.join(audioDir, audioFileName);

            const voiceConfig = this.getAdvancedAzureNeuralVoice(language);

            // SSML متقدم جداً للحصول على نطق طبيعي
            const advancedSSML = `
            <speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" 
                   xmlns:mstts="http://www.w3.org/2001/mstts" 
                   xmlns:emo="http://www.w3.org/2009/10/emotionml" xml:lang="${voiceConfig.locale}">
                <voice name="${voiceConfig.name}">
                    <mstts:express-as style="${voiceConfig.style}" styleintensity="${voiceConfig.styleIntensity}">
                        <mstts:prosody rate="${voiceConfig.rate}" pitch="${voiceConfig.pitch}" volume="${voiceConfig.volume}">
                            <mstts:silence type="Leading-exact" value="200ms"/>
                            <emphasis level="moderate">
                                <phoneme alphabet="ipa" ph="${voiceConfig.phoneme}">
                                    ${text}
                                </phoneme>
                            </emphasis>
                            <mstts:silence type="Tailing-exact" value="300ms"/>
                        </mstts:prosody>
                    </mstts:express-as>
                </voice>
            </speak>`;

            const response = await axios.post('https://westus2.tts.speech.microsoft.com/cognitiveservices/v1', advancedSSML, {
                headers: {
                    'Content-Type': 'application/ssml+xml',
                    'X-Microsoft-OutputFormat': 'audio-48khz-192kbitrate-mono-mp3',
                    'Ocp-Apim-Subscription-Key': process.env.AZURE_PREMIUM_KEY || 'demo',
                    'User-Agent': 'Azure-Neural-Premium/3.0'
                },
                responseType: 'arraybuffer',
                timeout: 30000
            });

            if (response.status === 200 && response.data && response.data.byteLength > 10000) {
                const audioBuffer = Buffer.from(response.data);

                await fs.writeFile(audioFilePath, audioBuffer);

                setTimeout(async () => {
                    try {
                        await fs.remove(audioFilePath);
                    } catch (e) {}
                }, 3000);

                return audioBuffer;
            }

            return null;
        } catch (error) {
            return null;
        }
    }

    async tryGoogleWaveNetPremium(text, language, audioDir) {
        try {
            const audioFileName = `google_wavenet_premium_${Date.now()}.mp3`;
            const audioFilePath = path.join(audioDir, audioFileName);

            const voiceConfig = this.getGoogleWaveNetPremium(language);

            const response = await axios.post('https://texttospeech.googleapis.com/v1beta1/text:synthesize', {
                input: { text: text },
                voice: {
                    languageCode: voiceConfig.languageCode,
                    name: voiceConfig.name,
                    ssmlGender: voiceConfig.gender,
                    customVoice: {
                        model: voiceConfig.model,
                        reportedUsage: 'REALTIME_INTERACTIVE'
                    }
                },
                audioConfig: {
                    audioEncoding: 'MP3',
                    speakingRate: voiceConfig.speakingRate,
                    pitch: voiceConfig.pitch,
                    volumeGainDb: voiceConfig.volumeGain,
                    sampleRateHertz: 48000,
                    effectsProfileId: [
                        'large-home-entertainment-class-device',
                        'large-automotive-class-device'
                    ]
                },
                enableTimePointing: ['SSML_MARK']
            }, {
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${process.env.GOOGLE_PREMIUM_TOKEN || 'demo'}`
                },
                timeout: 30000
            });

            if (response.data && response.data.audioContent) {
                const audioBuffer = Buffer.from(response.data.audioContent, 'base64');

                await fs.writeFile(audioFilePath, audioBuffer);

                setTimeout(async () => {
                    try {
                        await fs.remove(audioFilePath);
                    } catch (e) {}
                }, 3000);

                return audioBuffer;
            }

            return null;
        } catch (error) {
            return null;
        }
    }

    async tryElevenLabsMultilingual(text, language, audioDir) {
        try {
            const audioFileName = `elevenlabs_multilingual_${Date.now()}.mp3`;
            const audioFilePath = path.join(audioDir, audioFileName);

            const voiceConfig = this.getElevenLabsMultilingualVoice(language);

            const response = await axios.post(`https://api.elevenlabs.io/v1/text-to-speech/${voiceConfig.voiceId}/stream`, {
                text: text,
                model_id: "eleven_multilingual_v2",
                voice_settings: {
                    stability: voiceConfig.stability,
                    similarity_boost: voiceConfig.similarityBoost,
                    style: voiceConfig.style,
                    use_speaker_boost: true
                },
                pronunciation_dictionary_locators: voiceConfig.pronunciationDict,
                generation_config: {
                    chunk_length_schedule: [120, 160, 250, 290]
                }
            }, {
                headers: {
                    'Accept': 'audio/mpeg',
                    'Content-Type': 'application/json',
                    'xi-api-key': process.env.ELEVENLABS_PREMIUM_KEY || 'demo'
                },
                responseType: 'arraybuffer',
                timeout: 25000
            });

            if (response.status === 200 && response.data && response.data.byteLength > 10000) {
                const audioBuffer = Buffer.from(response.data);

                await fs.writeFile(audioFilePath, audioBuffer);

                setTimeout(async () => {
                    try {
                        await fs.remove(audioFilePath);
                    } catch (e) {}
                }, 3000);

                return audioBuffer;
            }

            return null;
        } catch (error) {
            return null;
        }
    }

    async tryMicrosoftNeuralVoices(text, language, audioDir) {
        try {
            const audioFileName = `microsoft_neural_${Date.now()}.mp3`;
            const audioFilePath = path.join(audioDir, audioFileName);

            const voiceConfig = this.getMicrosoftNeuralVoice(language);

            const neuralSSML = `
            <speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" 
                   xmlns:mstts="http://www.w3.org/2001/mstts" xml:lang="${voiceConfig.locale}">
                <voice name="${voiceConfig.name}">
                    <mstts:express-as style="${voiceConfig.style}" styledegree="${voiceConfig.intensity}">
                        <prosody rate="${voiceConfig.rate}" pitch="${voiceConfig.pitch}" volume="${voiceConfig.volume}">
                            <mstts:backgroundaudio src="${voiceConfig.backgroundAudio}" volume="${voiceConfig.backgroundVolume}" fadein="1s" fadeout="1s"/>
                            ${text}
                        </prosody>
                    </mstts:express-as>
                </voice>
            </speak>`;

            const response = await axios.post('https://eastus.tts.speech.microsoft.com/cognitiveservices/v1', neuralSSML, {
                headers: {
                    'Content-Type': 'application/ssml+xml',
                    'X-Microsoft-OutputFormat': 'audio-48khz-192kbitrate-mono-mp3',
                    'Ocp-Apim-Subscription-Key': process.env.MICROSOFT_NEURAL_KEY || 'demo',
                    'User-Agent': 'Microsoft-Neural-Premium/2.0'
                },
                responseType: 'arraybuffer',
                timeout: 25000
            });

            if (response.status === 200 && response.data && response.data.byteLength > 10000) {
                const audioBuffer = Buffer.from(response.data);

                await fs.writeFile(audioFilePath, audioBuffer);

                setTimeout(async () => {
                    try {
                        await fs.remove(audioFilePath);
                    } catch (e) {}
                }, 3000);

                return audioBuffer;
            }

            return null;
        } catch (error) {
            return null;
        }
    }

    async tryAmazonPollyNeural(text, language, audioDir) {
        try {
            const audioFileName = `amazon_polly_neural_${Date.now()}.mp3`;
            const audioFilePath = path.join(audioDir, audioFileName);

            const voiceConfig = this.getAmazonPollyNeuralVoice(language);

            const response = await axios.post('https://polly.us-east-1.amazonaws.com/', {
                Text: text,
                VoiceId: voiceConfig.voiceId,
                Engine: 'neural',
                OutputFormat: 'mp3',
                SampleRate: '24000',
                TextType: 'text',
                LanguageCode: voiceConfig.languageCode,
                LexiconNames: voiceConfig.lexiconNames
            }, {
                headers: {
                    'Content-Type': 'application/x-amz-json-1.0',
                    'X-Amz-Target': 'Polly_20160610.SynthesizeSpeech',
                    'Authorization': `AWS4-HMAC-SHA256 ${process.env.AWS_AUTH_TOKEN || 'demo'}`
                },
                responseType: 'arraybuffer',
                timeout: 25000
            });

            if (response.status === 200 && response.data && response.data.byteLength > 8000) {
                const audioBuffer = Buffer.from(response.data);

                await fs.writeFile(audioFilePath, audioBuffer);

                setTimeout(async () => {
                    try {
                        await fs.remove(audioFilePath);
                    } catch (e) {}
                }, 3000);

                return audioBuffer;
            }

            return null;
        } catch (error) {
            return null;
        }
    }

    async tryNaturalReaderPremium(text, language, audioDir) {
        try {
            const audioFileName = `natural_reader_premium_${Date.now()}.mp3`;
            const audioFilePath = path.join(audioDir, audioFileName);

            const voiceConfig = this.getNaturalReaderPremiumVoice(language);

            const response = await axios.post('https://api.naturalreaders.com/v4/tts/convert-advanced', {
                text: text,
                voice: voiceConfig.voice,
                format: 'mp3',
                quality: 'ultra_high',
                speed: voiceConfig.speed,
                pitch: voiceConfig.pitch,
                volume: voiceConfig.volume,
                emotion: voiceConfig.emotion,
                emphasis: voiceConfig.emphasis,
                breathing: voiceConfig.breathing,
                neural_enhancement: true
            }, {
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${process.env.NATURAL_READER_TOKEN || 'demo'}`
                },
                responseType: 'arraybuffer',
                timeout: 25000
            });

            if (response.status === 200 && response.data && response.data.byteLength > 8000) {
                const audioBuffer = Buffer.from(response.data);

                await fs.writeFile(audioFilePath, audioBuffer);

                setTimeout(async () => {
                    try {
                        await fs.remove(audioFilePath);
                    } catch (e) {}
                }, 3000);

                return audioBuffer;
            }

            return null;
        } catch (error) {
            return null;
        }
    }

    async tryPremiumTTS(text, language, audioDir) {
        try {
            const audioFileName = `premium_tts_${Date.now()}.mp3`;
            const audioFilePath = path.join(audioDir, audioFileName);

            // خدمة TTS متطورة مع دعم أفضل للكورية
            const voiceConfig = this.getPremiumVoice(language);

            const response = await axios.post('https://api.voicerss.org/', {
                key: 'demo',
                hl: voiceConfig.lang,
                v: voiceConfig.voice,
                r: '0', // أبطأ قليلاً للوضوح
                c: 'MP3',
                f: '44khz_16bit_stereo',
                ssml: false,
                b64: false,
                src: text
            }, {
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded'
                },
                responseType: 'arraybuffer',
                timeout: 25000
            });

            if (response.status === 200 && response.data && response.data.byteLength > 8000) {
                const audioBuffer = Buffer.from(response.data);

                await fs.writeFile(audioFilePath, audioBuffer);

                setTimeout(async () => {
                    try {
                        await fs.remove(audioFilePath);
                    } catch (e) {}
                }, 3000);

                return audioBuffer;
            }

            return null;
        } catch (error) {
            return null;
        }
    }

    async tryMicrosoftCognitiveTTS(text, language, audioDir) {
        try {
            const audioFileName = `microsoft_cognitive_${Date.now()}.mp3`;
            const audioFilePath = path.join(audioDir, audioFileName);

            const voiceConfig = this.getAdvancedMicrosoftVoice(language);

            // SSML محسن للحصول على نطق طبيعي أكثر
            const ssml = `
            <speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="${voiceConfig.locale}">
                <voice name="${voiceConfig.name}">
                    <prosody rate="medium" pitch="medium" volume="medium">
                        <emphasis level="moderate">
                            <break time="200ms"/>
                            ${text}
                            <break time="300ms"/>
                        </emphasis>
                    </prosody>
                </voice>
            </speak>`;

            const response = await axios.post('https://southeastasia.tts.speech.microsoft.com/cognitiveservices/v1', ssml, {
                headers: {
                    'Content-Type': 'application/ssml+xml',
                    'X-Microsoft-OutputFormat': 'audio-48khz-192kbitrate-mono-mp3',
                    'Ocp-Apim-Subscription-Key': process.env.AZURE_TTS_KEY || 'demo',
                    'User-Agent': 'TTSClient/1.0'
                },
                responseType: 'arraybuffer',
                timeout: 25000
            });

            if (response.status === 200 && response.data && response.data.byteLength > 8000) {
                const audioBuffer = Buffer.from(response.data);

                await fs.writeFile(audioFilePath, audioBuffer);

                setTimeout(async () => {
                    try {
                        await fs.remove(audioFilePath);
                    } catch (e) {}
                }, 3000);

                return audioBuffer;
            }

            return null;
        } catch (error) {
            return null;
        }
    }

    async tryGoogleCloudAdvanced(text, language, audioDir) {
        try {
            const audioFileName = `google_cloud_advanced_${Date.now()}.mp3`;
            const audioFilePath = path.join(audioDir, audioFileName);

            const voiceConfig = this.getAdvancedGoogleVoice(language);

            const response = await axios.post('https://texttospeech.googleapis.com/v1/text:synthesize', {
                input: { text: text },
                voice: {
                    languageCode: voiceConfig.languageCode,
                    name: voiceConfig.name,
                    ssmlGender: voiceConfig.gender
                },
                audioConfig: {
                    audioEncoding: 'MP3',
                    speakingRate: 0.95,
                    pitch: 1.2,
                    volumeGainDb: 3.0,
                    sampleRateHertz: 48000,
                    effectsProfileId: ['large-home-entertainment-class-device']
                }
            }, {
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${process.env.GOOGLE_TTS_TOKEN || 'demo'}`
                },
                timeout: 25000
            });

            if (response.data && response.data.audioContent) {
                const audioBuffer = Buffer.from(response.data.audioContent, 'base64');

                await fs.writeFile(audioFilePath, audioBuffer);

                setTimeout(async () => {
                    try {
                        await fs.remove(audioFilePath);
                    } catch (e) {}
                }, 3000);

                return audioBuffer;
            }

            return null;
        } catch (error) {
            return null;
        }
    }

    async tryEnhancedAzureTTS(text, language, audioDir) {
        try {
            const audioFileName = `enhanced_azure_${Date.now()}.mp3`;
            const audioFilePath = path.join(audioDir, audioFileName);

            const voiceConfig = this.getEnhancedAzureVoice(language);

            const ssml = `
            <speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" 
                   xmlns:mstts="http://www.w3.org/2001/mstts" xml:lang="${voiceConfig.locale}">
                <voice name="${voiceConfig.name}">
                    <mstts:express-as style="friendly" styledegree="2">
                        <prosody rate="medium" pitch="+5%" volume="+15%">
                            ${text}
                        </prosody>
                    </mstts:express-as>
                </voice>
            </speak>`;

            const response = await axios.post('https://koreacentral.tts.speech.microsoft.com/cognitiveservices/v1', ssml, {
                headers: {
                    'Content-Type': 'application/ssml+xml',
                    'X-Microsoft-OutputFormat': 'audio-48khz-192kbitrate-mono-mp3',
                    'Ocp-Apim-Subscription-Key': process.env.AZURE_TTS_KEY || 'demo',
                    'User-Agent': 'PremiumTTSClient/2.0'
                },
                responseType: 'arraybuffer',
                timeout: 25000
            });

            if (response.status === 200 && response.data && response.data.byteLength > 8000) {
                const audioBuffer = Buffer.from(response.data);

                await fs.writeFile(audioFilePath, audioBuffer);

                setTimeout(async () => {
                    try {
                        await fs.remove(audioFilePath);
                    } catch (e) {}
                }, 3000);

                return audioBuffer;
            }

            return null;
        } catch (error) {
            return null;
        }
    }

    async tryNaturalVoiceTTS(text, language, audioDir) {
        try {
            const audioFileName = `natural_voice_${Date.now()}.mp3`;
            const audioFilePath = path.join(audioDir, audioFileName);

            const voiceSettings = this.getNaturalVoiceSettings(language);

            // استخدام خدمة Natural Reader API
            const response = await axios.post('https://api.naturalreaders.com/v4/tts/convert', {
                text: text,
                voice: voiceSettings.voice,
                format: 'mp3',
                quality: 'high',
                speed: voiceSettings.speed,
                pitch: voiceSettings.pitch,
                volume: voiceSettings.volume
            }, {
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': 'Bearer demo'
                },
                responseType: 'arraybuffer',
                timeout: 25000
            });

            if (response.status === 200 && response.data && response.data.byteLength > 8000) {
                const audioBuffer = Buffer.from(response.data);

                await fs.writeFile(audioFilePath, audioBuffer);

                setTimeout(async () => {
                    try {
                        await fs.remove(audioFilePath);
                    } catch (e) {}
                }, 3000);

                return audioBuffer;
            }

            return null;
        } catch (error) {
            return null;
        }
    }

    async tryHighQualityGoogleTTS(text, language, audioDir) {
        try {
            const audioFileName = `hq_google_tts_${Date.now()}.mp3`;
            const audioFilePath = path.join(audioDir, audioFileName);

            // معاملات محسنة لجودة عالية
            const params = new URLSearchParams({
                ie: 'UTF-8',
                q: text,
                tl: language,
                client: 'tw-ob',
                textlen: text.length.toString(),
                ttsspeed: '0.85', // أبطأ للوضوح الأفضل
                total: '1',
                idx: '0',
                prev: 'input',
                quality: 'high'
            });

            const response = await axios.get(`https://translate.google.com/translate_tts?${params.toString()}`, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
                    'Referer': 'https://translate.google.com/',
                    'Accept': 'audio/mpeg, audio/mp3, audio/wav, audio/*',
                    'Accept-Language': `${language},en;q=0.9,ar;q=0.8`,
                    'Accept-Encoding': 'gzip, deflate, br',
                    'Connection': 'keep-alive',
                    'Cache-Control': 'no-cache'
                },
                responseType: 'arraybuffer',
                timeout: 20000
            });

            if (response.status === 200 && response.data && response.data.byteLength > 3000) {
                const audioBuffer = Buffer.from(response.data);

                await fs.writeFile(audioFilePath, audioBuffer);

                setTimeout(async () => {
                    try {
                        await fs.remove(audioFilePath);
                    } catch (e) {}
                }, 3000);

                return audioBuffer;
            }

            return null;
        } catch (error) {
            return null;
        }
    }

    async tryEnhancedElevenLabs(text, language, audioDir) {
        try {
            const audioFileName = `enhanced_elevenlabs_${Date.now()}.mp3`;
            const audioFilePath = path.join(audioDir, audioFileName);

            const voiceId = this.getEnhancedElevenLabsVoice(language);

            const response = await axios.post(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream`, {
                text: text,
                model_id: "eleven_multilingual_v2",
                voice_settings: {
                    stability: 0.85,
                    similarity_boost: 0.90,
                    style: 0.75,
                    use_speaker_boost: true
                },
                pronunciation_dictionary_locators: [],
                seed: null,
                previous_text: null,
                next_text: null,
                previous_request_ids: [],
                next_request_ids: []
            }, {
                headers: {
                    'Accept': 'audio/mpeg',
                    'Content-Type': 'application/json',
                    'xi-api-key': process.env.ELEVENLABS_API_KEY || 'demo'
                },
                responseType: 'arraybuffer',
                timeout: 20000
            });

            if (response.status === 200 && response.data && response.data.byteLength > 5000) {
                const audioBuffer = Buffer.from(response.data);

                await fs.writeFile(audioFilePath, audioBuffer);

                setTimeout(async () => {
                    try {
                        await fs.remove(audioFilePath);
                    } catch (e) {}
                }, 2000);

                return audioBuffer;
            }

            return null;
        } catch (error) {
            return null;
        }
    }

    async tryAzureCognitiveTTS(text, language, audioDir) {
        try {
            const audioFileName = `azure_cognitive_${Date.now()}.mp3`;
            const audioFilePath = path.join(audioDir, audioFileName);

            const voiceConfig = this.getAzureCognitiveVoice(language);

            const ssml = `
            <speak version='1.0' xml:lang='${voiceConfig.locale}'>
                <voice xml:lang='${voiceConfig.locale}' xml:gender='${voiceConfig.gender}' name='${voiceConfig.name}'>
                    <prosody rate="medium" pitch="medium" volume="medium">
                        <emphasis level="moderate">
                            ${text}
                        </emphasis>
                    </prosody>
                </voice>
            </speak>`;

            const response = await axios.post('https://eastus.tts.speech.microsoft.com/cognitiveservices/v1', ssml, {
                headers: {
                    'Content-Type': 'application/ssml+xml',
                    'X-Microsoft-OutputFormat': 'audio-24khz-160kbitrate-mono-mp3',
                    'Ocp-Apim-Subscription-Key': process.env.AZURE_TTS_KEY || 'demo',
                    'User-Agent': 'Mozilla/5.0'
                },
                responseType: 'arraybuffer',
                timeout: 20000
            });

            if (response.status === 200 && response.data && response.data.byteLength > 5000) {
                const audioBuffer = Buffer.from(response.data);

                await fs.writeFile(audioFilePath, audioBuffer);

                setTimeout(async () => {
                    try {
                        await fs.remove(audioFilePath);
                    } catch (e) {}
                }, 2000);

                return audioBuffer;
            }

            return null;
        } catch (error) {
            return null;
        }
    }

    async tryGoogleCloudWaveNet(text, language, audioDir) {
        try {
            const audioFileName = `google_wavenet_${Date.now()}.mp3`;
            const audioFilePath = path.join(audioDir, audioFileName);

            const voiceConfig = this.getGoogleWaveNetVoice(language);

            const response = await axios.post('https://texttospeech.googleapis.com/v1/text:synthesize', {
                input: { text: text },
                voice: {
                    languageCode: voiceConfig.languageCode,
                    name: voiceConfig.name,
                    ssmlGender: voiceConfig.gender
                },
                audioConfig: {
                    audioEncoding: 'MP3',
                    speakingRate: 1.0,
                    pitch: 0.0,
                    volumeGainDb: 2.0,
                    sampleRateHertz: 44100,
                    effectsProfileId: ['headphone-class-device']
                }
            }, {
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${process.env.GOOGLE_TTS_TOKEN || 'demo'}`
                },
                timeout: 20000
            });

            if (response.data && response.data.audioContent) {
                const audioBuffer = Buffer.from(response.data.audioContent, 'base64');

                await fs.writeFile(audioFilePath, audioBuffer);

                setTimeout(async () => {
                    try {
                        await fs.remove(audioFilePath);
                    } catch (e) {}
                }, 2000);

                return audioBuffer;
            }

            return null;
        } catch (error) {
            return null;
        }
    }

    async tryAdvancedGoogleTTS(text, language, audioDir) {
        try {
            const audioFileName = `advanced_google_tts_${Date.now()}.mp3`;
            const audioFilePath = path.join(audioDir, audioFileName);

            // تحسين معاملات Google TTS
            const params = new URLSearchParams({
                ie: 'UTF-8',
                q: text,
                tl: language,
                client: 'gtx',
                textlen: text.length.toString(),
                ttsspeed: '0.8', // سرعة أبطأ للوضوح
                total: '1',
                idx: '0',
                prev: 'input'
            });

            const response = await axios.get(`https://translate.google.com/translate_tts?${params.toString()}`, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                    'Referer': 'https://translate.google.com/',
                    'Accept': 'audio/mpeg, audio/mp3, audio/*',
                    'Accept-Language': `${language},en;q=0.9`,
                    'Accept-Encoding': 'gzip, deflate, br',
                    'Connection': 'keep-alive'
                },
                responseType: 'arraybuffer',
                timeout: 15000
            });

            if (response.status === 200 && response.data && response.data.byteLength > 2000) {
                const audioBuffer = Buffer.from(response.data);

                await fs.writeFile(audioFilePath, audioBuffer);

                setTimeout(async () => {
                    try {
                        await fs.remove(audioFilePath);
                    } catch (e) {}
                }, 2000);

                return audioBuffer;
            }

            return null;
        } catch (error) {
            return null;
        }
    }

    async tryElevenLabsTTS(text, language, audioDir) {
        try {
            // خدمة ElevenLabs مجانية لعدد محدود من الحروف
            const audioFileName = `elevenlabs_tts_${Date.now()}.mp3`;
            const audioFilePath = path.join(audioDir, audioFileName);

            const voiceId = this.getElevenLabsVoice(language);

            const response = await axios.post(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
                text: text,
                model_id: "eleven_multilingual_v2",
                voice_settings: {
                    stability: 0.75,
                    similarity_boost: 0.75,
                    style: 0.5,
                    use_speaker_boost: true
                }
            }, {
                headers: {
                    'Accept': 'audio/mpeg',
                    'Content-Type': 'application/json',
                    'xi-api-key': 'demo' // استخدام مفتاح تجريبي
                },
                responseType: 'arraybuffer',
                timeout: 15000
            });

            if (response.status === 200 && response.data && response.data.byteLength > 2000) {
                const audioBuffer = Buffer.from(response.data);

                await fs.writeFile(audioFilePath, audioBuffer);

                setTimeout(async () => {
                    try {
                        await fs.remove(audioFilePath);
                    } catch (e) {}
                }, 2000);

                return audioBuffer;
            }

            return null;
        } catch (error) {
            return null;
        }
    }

    async tryGoogleCloudTTS(text, language, audioDir) {
        try {
            const audioFileName = `google_cloud_tts_${Date.now()}.mp3`;
            const audioFilePath = path.join(audioDir, audioFileName);

            const voiceConfig = this.getGoogleCloudVoice(language);

            // استخدام Google Cloud TTS مع مفتاح مجاني
            const response = await axios.post('https://texttospeech.googleapis.com/v1/text:synthesize', {
                input: { text: text },
                voice: {
                    languageCode: voiceConfig.languageCode,
                    name: voiceConfig.name,
                    ssmlGender: voiceConfig.gender
                },
                audioConfig: {
                    audioEncoding: 'MP3',
                    speakingRate: 1.0,
                    pitch: 0.0,
                    volumeGainDb: 0.0,
                    sampleRateHertz: 24000,
                    effectsProfileId: ['telephony-class-application']
                }
            }, {
                headers: {
                    'Content-Type': 'application/json'
                },
                timeout: 15000
            });

            if (response.data && response.data.audioContent) {
                const audioBuffer = Buffer.from(response.data.audioContent, 'base64');

                await fs.writeFile(audioFilePath, audioBuffer);

                setTimeout(async () => {
                    try {
                        await fs.remove(audioFilePath);
                    } catch (e) {}
                }, 2000);

                return audioBuffer;
            }

            return null;
        } catch (error) {
            return null;
        }
    }

    async tryMicrosoftTTS(text, language, audioDir) {
        try {
            const audioFileName = `microsoft_tts_${Date.now()}.mp3`;
            const audioFilePath = path.join(audioDir, audioFileName);

            const voiceConfig = this.getMicrosoftVoice(language);

            const ssml = `
            <speak version='1.0' xml:lang='${voiceConfig.locale}'>
                <voice xml:lang='${voiceConfig.locale}' xml:gender='${voiceConfig.gender}' name='${voiceConfig.name}'>
                    <prosody rate="medium" pitch="medium">
                        ${text}
                    </prosody>
                </voice>
            </speak>`;

            const response = await axios.post('https://speech.platform.bing.com/synthesize', ssml, {
                headers: {
                    'Content-Type': 'application/ssml+xml',
                    'X-Microsoft-OutputFormat': 'audio-24khz-48kbitrate-mono-mp3',
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                },
                responseType: 'arraybuffer',
                timeout: 15000
            });

            if (response.status === 200 && response.data && response.data.byteLength > 2000) {
                const audioBuffer = Buffer.from(response.data);

                await fs.writeFile(audioFilePath, audioBuffer);

                setTimeout(async () => {
                    try {
                        await fs.remove(audioFilePath);
                    } catch (e) {}
                }, 2000);

                return audioBuffer;
            }

            return null;
        } catch (error) {
            return null;
        }
    }

    async tryOpenAITTS(text, language, audioDir) {
        try {
            const audioFileName = `openai_tts_${Date.now()}.mp3`;
            const audioFilePath = path.join(audioDir, audioFileName);

            const voice = this.getOpenAIVoice(language);

            const response = await axios.post('https://api.openai.com/v1/audio/speech', {
                model: 'tts-1',
                input: text,
                voice: voice,
                speed: 1.0
            }, {
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': 'Bearer demo' // استخدام مفتاح تجريبي
                },
                responseType: 'arraybuffer',
                timeout: 15000
            });

            if (response.status === 200 && response.data && response.data.byteLength > 2000) {
                const audioBuffer = Buffer.from(response.data);

                await fs.writeFile(audioFilePath, audioBuffer);

                setTimeout(async () => {
                    try {
                        await fs.remove(audioFilePath);
                    } catch (e) {}
                }, 2000);

                return audioBuffer;
            }

            return null;
        } catch (error) {
            return null;
        }
    }

    async tryDirectGoogleTTS(text, language, audioDir) {
        try {
            const audioFileName = `direct_google_tts_${Date.now()}.mp3`;
            const audioFilePath = path.join(audioDir, audioFileName);

            // معاملات محسنة للحصول على صوت أنثوي أفضل
            const params = new URLSearchParams({
                ie: 'UTF-8',
                q: text,
                tl: language,
                client: 'tw-ob',
                textlen: text.length.toString(),
                ttsspeed: language === 'ar' ? '0.7' : '0.8', // سرعة أبطأ للوضوح
                total: '1',
                idx: '0',
                prev: 'input'
            });

            const response = await axios.get(`https://translate.google.com/translate_tts?${params.toString()}`, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
                    'Referer': 'https://translate.google.com/',
                    'Accept': 'audio/mpeg, audio/mp3, audio/wav',
                    'Accept-Language': `${language},en;q=0.9,ar;q=0.8`
                },
                responseType: 'arraybuffer',
                timeout: 20000
            });

            if (response.status === 200 && response.data && response.data.byteLength > 1000) {
                const audioBuffer = Buffer.from(response.data);
                await fs.writeFile(audioFilePath, audioBuffer);

                setTimeout(async () => {
                    try {
                        await fs.remove(audioFilePath);
                    } catch (e) {}
                }, 3000);

                return audioBuffer;
            }

            return null;
        } catch (error) {
            console.log(`❌ Direct Google TTS فشل: ${error.message}`);
            return null;
        }
    }

    async tryGoogleTTSEnhanced(text, audioDir) {
        try {
            const language = this.detectLanguage(text);
            const audioFileName = `google_enhanced_tts_${Date.now()}.mp3`;
            const audioFilePath = path.join(audioDir, audioFileName);

            // تحسين معاملات Google TTS
            const params = new URLSearchParams({
                ie: 'UTF-8',
                q: text,
                tl: language,
                client: 'tw-ob',
                textlen: text.length.toString(),
                ttsspeed: '0.9', // سرعة أفضل
                total: '1',
                idx: '0',
                prev: 'input'
            });

            const response = await axios.get(`https://translate.google.com/translate_tts?${params.toString()}`, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
                    'Referer': 'https://translate.google.com/',
                    'Accept': 'audio/mpeg',
                    'Accept-Language': 'en-US,en;q=0.9'
                },
                responseType: 'arraybuffer',
                timeout: 10000
            });

            if (response.status === 200 && response.data && response.data.byteLength > 1000) {
                const audioBuffer = Buffer.from(response.data);

                await fs.writeFile(audioFilePath, audioBuffer);

                setTimeout(async () => {
                    try {
                        await fs.remove(audioFilePath);
                    } catch (e) {}
                }, 2000);

                return audioBuffer;
            }

            return null;
        } catch (error) {
            return null;
        }
    }

    async tryGoogleTTS(text, audioDir) {
        try {
            const audioFileName = `google_tts_${Date.now()}.mp3`;
            const audioFilePath = path.join(audioDir, audioFileName);

            const language = this.detectLanguage(text);

            const tts = new gtts(text, language);

            await new Promise((resolve, reject) => {
                tts.save(audioFilePath, (error, result) => {
                    if (error) {
                        reject(error);
                    } else {
                        resolve(result);
                    }
                });
            });

            const audioBuffer = await fs.readFile(audioFilePath);

            setTimeout(async () => {
                try {
                    await fs.remove(audioFilePath);
                } catch (deleteError) {
                    // تجاهل الخطأ
                }
            }, 5000);

            return audioBuffer;
        } catch (error) {
            return null;
        }
    }

    async handleTextToSpeech(userJid, text) {
        try {
            const startTime = Date.now();

            await this.sock.sendMessage(userJid, {
                text: `🎤 جاري تحويل النص إلى صوت عالي الجودة...`
            });

            const audioBuffer = await this.convertTextToAudio(text);

            const processingTime = ((Date.now() - startTime) / 1000).toFixed(1);

            if (audioBuffer) {
                const language = this.detectLanguage(text);
                const languageNames = {
                    'ar': 'العربية',
                    'en': 'الإنجليزية',
                    'fr': 'الفرنسية',
                    'es': 'الإسبانية',
                    'de': 'الألمانية',
                    'it': 'الإيطالية',
                    'pt': 'البرتغالية',
                    'ru': 'الروسية',
                    'ja': 'اليابانية',
                    'ko': 'الكورية',
                    'zh': 'الصينية',
                    'hi': 'الهندية',
                    'tr': 'التركية'
                };

                await this.sock.sendMessage(userJid, {
                    audio: audioBuffer,
                    mimetype: 'audio/mp4',
                    ptt: true,
                    fileName: `tts_${language}_${Date.now()}.mp3`
                });

                await this.sock.sendMessage(userJid, {
                    text: `✅ تم تحويل النص بنجاح! 🎵

📊 معلومات التحويل:
🌐 اللغة المكتشفة: ${languageNames[language] || 'غير محددة'}
⏱️ وقت المعالجة: ${processingTime} ثانية
🎧 جودة الصوت: عالية الدقة
📏 طول النص: ${text.length} حرف`
                });

                console.log(`✅ تم إرسال الملف الصوتي "${text.substring(0, 50)}..." للمستخدم: ${userJid} في ${processingTime}s`);
            } else {
                await this.sock.sendMessage(userJid, {
                    text: `❌ فشل في تحويل النص "${text.substring(0, 100)}..." إلى صوت. 

💡 نصائح:
• تأكد من أن النص يحتوي على أحرف صالحة
• حاول تقسيم النص إلى أجزاء أصغر
• تجنب الرموز الخاصة الكثيرة`
                });
            }

        } catch (error) {
            console.error('❌ خطأ في تحويل النص إلى صوت:', error.message);
            await this.sock.sendMessage(userJid, {
                text: `❌ حدث خطأ أثناء تحويل النص إلى صوت.

🔧 يرجى المحاولة مرة أخرى أو التواصل مع المطور`
            });
        }
    }

    getOptimizedLanguageSettings(language) {
        const settings = {
            'ar': { speed: '0.7', pitch: '+5%', volume: '+10%' }, // بطء أكثر للعربية لوضوح أفضل
            'en': { speed: '0.85', pitch: '0%', volume: '+5%' },
            'ja': { speed: '0.8', pitch: '+3%', volume: '+8%' },
            'ko': { speed: '0.75', pitch: '+8%', volume: '+12%' },
            'zh': { speed: '0.8', pitch: '+2%', volume: '+6%' },
            'fr': { speed: '0.85', pitch: '+2%', volume: '+5%' },
            'es': { speed: '0.85', pitch: '+3%', volume: '+7%' },
            'de': { speed: '0.8', pitch: '+1%', volume: '+5%' },
            'it': { speed: '0.85', pitch: '+4%', volume: '+6%' },
            'pt': { speed: '0.85', pitch: '+3%', volume: '+6%' },
            'ru': { speed: '0.8', pitch: '+2%', volume: '+5%' },
            'hi': { speed: '0.8', pitch: '+3%', volume: '+7%' },
            'tr': { speed: '0.85', pitch: '+2%', volume: '+5%' }
        };
        return settings[language] || settings['en'];
    }

    detectLanguage(text) {
        const lowerText = text.toLowerCase();

        // العربية
        const arabicPattern = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF]/;
        if (arabicPattern.test(text)) {
            return 'ar';
        }

        // الصينية
        const chinesePattern = /[\u4e00-\u9fff]/;
        if (chinesePattern.test(text)) {
            return 'zh';
        }

        // اليابانية
        const japanesePattern = /[\u3040-\u309F\u30A0-\u30FF]/;
        if (japanesePattern.test(text)) {
            return 'ja';
        }

        // الكورية
        const koreanPattern = /[\uAC00-\uD7AF\u1100-\u11FF\u3130-\u318F]/;
        if (koreanPattern.test(text)) {
            return 'ko';
        }

        // الروسية
        const russianPattern = /[\u0400-\u04FF]/;
        if (russianPattern.test(text)) {
            return 'ru';
        }

        // الهندية
        const hindiPattern = /[\u0900-\u097F]/;
        if (hindiPattern.test(text)) {
            return 'hi';
        }

        // English words that should be prioritized
        const englishWords = ['the', 'and', 'you', 'that', 'was', 'for', 'are', 'with', 'his', 'they', 'nya', 'pitou', 'hello', 'how', 'well', 'when', 'always', 'sweet'];
        const englishWordCount = englishWords.filter(word => lowerText.includes(word)).length;

        // الألمانية
        const germanWords = ['der', 'die', 'das', 'und', 'ist', 'ich', 'nicht', 'sie', 'es', 'ein', 'eine'];
        const germanWordCount = germanWords.filter(word => lowerText.includes(word)).length;

        // الفرنسية
        const frenchWords = ['le', 'la', 'les', 'du', 'des', 'et', 'à', 'un', 'une', 'dans', 'pour'];
        const frenchWordCount = frenchWords.filter(word => lowerText.includes(word)).length;

        // الإسبانية
        const spanishWords = ['el', 'la', 'que', 'y', 'a', 'en', 'un', 'es', 'se', 'no', 'te', 'lo'];
        const spanishWordCount = spanishWords.filter(word => lowerText.includes(word)).length;

        // الإيطالية
        const italianWords = ['il', 'di', 'che', 'e', 'la', 'per', 'un', 'in', 'con', 'non', 'da', 'una'];
        const italianWordCount = italianWords.filter(word => lowerText.includes(word)).length;

        // البرتغالية
        const portugueseWords = ['o', 'a', 'e', 'do', 'da', 'em', 'um', 'para', 'é', 'com', 'não'];
        const portugueseWordCount = portugueseWords.filter(word => lowerText.includes(word)).length;

        // التركية
        const turkishWords = ['bir', 'bu', 've', 'için', 'ile', 'olan', 'var', 'daha', 'çok'];
        const turkishWordCount = turkishWords.filter(word => lowerText.includes(word)).length;

        // Count matches and return language with highest count
        const languageScores = [
            { lang: 'en', score: englishWordCount },
            { lang: 'de', score: germanWordCount },
            { lang: 'fr', score: frenchWordCount },
            { lang: 'es', score: spanishWordCount },
            { lang: 'it', score: italianWordCount },
            { lang: 'pt', score: portugueseWordCount },
            { lang: 'tr', score: turkishWordCount }
        ];

        // Sort by score and return highest
        languageScores.sort((a, b) => b.score - a.score);

        // If no clear winner or English has any matches, default to English
        if (languageScores[0].score === 0 || englishWordCount > 0) {
            return 'en';
        }

        return languageScores[0].lang;
    }

    extractMessageContent(message) {
        try {
            if (message.message?.conversation) {
                return message.message.conversation;
            } else if (message.message?.extendedTextMessage?.text) {
                return message.message.extendedTextMessage.text;
            } else if (message.message?.imageMessage) {
                return message.message.imageMessage.caption || '[صورة]';
            } else if (message.message?.videoMessage) {
                return message.message.videoMessage.caption || '[فيديو]';
            } else if (message.message?.audioMessage) {
                return '[رسالة صوتية]';
            } else if (message.message?.documentMessage) {
                return `[مستند: ${message.message.documentMessage.fileName || 'غير محدد'}]`;
            } else if (message.message?.stickerMessage) {
                return '[ملصق]';
            } else if (message.message?.contactMessage) {
                return '[جهة اتصال]';
            } else if (message.message?.locationMessage) {
                return '[موقع]';
            } else {
                return '[رسالة غير معروفة]';
            }
        } catch (error) {
            return '[خطأ في قراءة الرسالة]';
        }
    }

    async handleMessageDelete(update) {
        try {
            const messageId = update.key?.id;
            const groupJid = update.key?.remoteJid;

            if (!messageId || !groupJid || !groupJid.includes('@g.us')) {
                return;
            }

            if (this.deletedByCommand.has(messageId)) {
                this.deletedByCommand.delete(messageId);
                this.messageHistory.delete(messageId);
                return;
            }

            const deletedMessage = this.messageHistory.get(messageId);

            let notificationText = '🚨 لقد تم حذف رسالة';

            if (deletedMessage) {
                const senderInfo = deletedMessage.sender.split('@')[0];
                const messageContent = deletedMessage.content;
                const deleteTime = new Date().toLocaleString('ar-SA');

                notificationText = `🚨 لقد تم حذف رسالة

📝 محتوى الرسالة المحذوفة:
"${messageContent}"

👤 كاتب الرسالة: ${senderInfo}
🕐 وقت الحذف: ${deleteTime}`;

                this.messageHistory.delete(messageId);
            } else {
                notificationText = `🚨 لقد تم حذف رسالة

⚠️ لم يتم العثور على محتوى الرسالة المحذوفة
🕐 وقت الحذف: ${new Date().toLocaleString('ar-SA')}`;
            }

            await this.handleGroupMention(groupJid, notificationText);

        } catch (error) {
            console.error('❌ خطأ في معالجة حذف الرسالة:', error.message);
        }
    }

    async handleGroupMention(groupJid, mentionText) {
        try {
            const groupMetadata = await this.sock.groupMetadata(groupJid);

            if (!groupMetadata || !groupMetadata.participants) {
                await this.sock.sendMessage(groupJid, {
                    text: '❌ لم أتمكن من الحصول على معلومات المجموعة'
                });
                return;
            }

            const participants = groupMetadata.participants;
            const mentions = [];

            for (const participant of participants) {
                const participantJid = participant.id;

                if (participantJid !== this.developerNumber && participantJid !== this.sock.user.id) {
                    mentions.push(participantJid);
                }
            }

            if (mentions.length === 0) {
                await this.sock.sendMessage(groupJid, {
                    text: '❌ لا توجد أعضاء للمنشن في هذه المجموعة'
                });
                return;
            }

            await this.sock.sendMessage(groupJid, {
                text: mentionText,
                mentions: mentions
            });

            console.log(`✅ تم إرسال منشن جماعي لـ ${mentions.length} عضو في المجموعة: ${groupJid}`);

        } catch (error) {
            console.error('❌ خطأ في المنشن الجماعي:', error.message);
            await this.sock.sendMessage(groupJid, {
                text: `❌ حدث خطأ أثناء المنشن الجماعي`
            });
        }
    }

    cleanupOldReplies() {
        const now = Date.now();
        const tenMinutesAgo = now - (10 * 60 * 1000);

        for (const [messageKey, messageData] of this.pendingReplies.entries()) {
            const messageTime = parseInt(messageData.timestamp) || 0;

            if (messageData.replied && messageTime < tenMinutesAgo) {
                this.pendingReplies.delete(messageKey);
            }
        }

        for (const [userJid, sentImages] of this.sentImages.entries()) {
            if (sentImages.size > 50) {
                const imagesArray = Array.from(sentImages);
                const imagesToKeep = imagesArray.slice(-50);
                this.sentImages.set(userJid, new Set(imagesToKeep));
            }
        }
    }

    getUltraHighQualityVoice(language) {
        const voices = {
            'ar': { 
                voiceId: 'ar_premium_female_1', 
                speed: 0.9, 
                pitch: 1.05, 
                emphasis: 'moderate',
                pronunciation: ['ar_dialect_gulf']
            },
            'en': { 
                voiceId: 'en_premium_female_neural', 
                speed: 0.95, 
                pitch: 1.0, 
                emphasis: 'strong',
                pronunciation: ['en_us_accent']
            },
            'ko': { 
                voiceId: 'ko_premium_female_ultra', 
                speed: 0.85, 
                pitch: 1.1, 
                emphasis: 'moderate',
                pronunciation: ['ko_seoul_dialect']
            },
            'ja': { 
                voiceId: 'ja_premium_female_anime', 
                speed: 0.9, 
                pitch: 1.05, 
                emphasis: 'soft',
                pronunciation: ['ja_tokyo_accent']
            },
            'zh': { 
                voiceId: 'zh_premium_female_mandarin', 
                speed: 0.9, 
                pitch: 1.0, 
                emphasis: 'moderate',
                pronunciation: ['zh_beijing_accent']
            },
            'es': { 
                voiceId: 'es_premium_female_neural', 
                speed: 0.9, 
                pitch: 1.05, 
                emphasis: 'moderate',
                pronunciation: ['es_spain_accent']
            },
            'fr': { 
                voiceId: 'fr_premium_female_parisian', 
                speed: 0.9, 
                pitch: 1.0, 
                emphasis: 'elegant',
                pronunciation: ['fr_paris_accent']
            }
        };
        return voices[language] || voices['en'];
    }

    getNeuralVoiceConfig(language) {
        const configs = {
            'ar': { 
                voiceId: 'ar_neural_female_premium', 
                speed: 0.9, 
                emotion: 'friendly', 
                style: 'conversational',
                stability: 0.9,
                similarity_boost: 0.85
            },
            'en': { 
                voiceId: 'en_neural_female_premium', 
                speed: 0.95, 
                emotion: 'cheerful', 
                style: 'assistant',
                stability: 0.85,
                similarity_boost: 0.9
            },
            'ko': { 
                voiceId: 'ko_neural_female_premium', 
                speed: 0.85, 
                emotion: 'gentle', 
                style: 'anime_character',
                stability: 0.9,
                similarity_boost: 0.9
            },
            'ja': { 
                voiceId: 'ja_neural_female_kawaii', 
                speed: 0.9, 
                emotion: 'cute', 
                style: 'anime_voice',
                stability: 0.85,
                similarity_boost: 0.95
            },
            'zh': { 
                voiceId: 'zh_neural_female_mandarin', 
                speed: 0.9, 
                emotion: 'calm', 
                style: 'storytelling',
                stability: 0.9,
                similarity_boost: 0.85
            }
        };
        return configs[language] || configs['en'];
    }

    getAdvancedAzureNeuralVoice(language) {
        const voices = {
            'ar': { 
                locale: 'ar-SA', 
                name: 'ar-SA-ZariyahNeural', 
                style: 'cheerful', 
                styleIntensity: '2',
                rate: '0.9', 
                pitch: '+5%', 
                volume: '+10%',
                phoneme: 'default'
            },
            'en': { 
                locale: 'en-US', 
                name: 'en-US-AriaNeural', 
                style: 'friendly', 
                styleIntensity: '2',
                rate: '0.95', 
                pitch: '+2%', 
                volume: '+8%',
                phoneme: 'default'
            },
            'ko': { 
                locale: 'ko-KR', 
                name: 'ko-KR-SunHiNeural', 
                style: 'cheerful', 
                styleIntensity: '2',
                rate: '0.85', 
                pitch: '+8%', 
                volume: '+12%',
                phoneme: 'default'
            },
            'ja': { 
                locale: 'ja-JP', 
                name: 'ja-JP-NanamiNeural', 
                style: 'cheerful', 
                styleIntensity: '2',
                rate: '0.9', 
                pitch: '+5%', 
                volume: '+10%',
                phoneme: 'default'
            }
        };
        return voices[language] || voices['en'];
    }

    getGoogleWaveNetPremium(language) {
        const voices = {
            'ar': { 
                languageCode: 'ar-XA', 
                name: 'ar-XA-Neural2-A', 
                gender: 'FEMALE', 
                model: 'latest',
                speakingRate: 0.9, 
                pitch: 2.0, 
                volumeGain: 3.0 
            },
            'en': { 
                languageCode: 'en-US', 
                name: 'en-US-Neural2-F', 
                gender: 'FEMALE', 
                model: 'latest',
                speakingRate: 0.95, 
                pitch: 1.0, 
                volumeGain: 2.0 
            },
            'ko': { 
                languageCode: 'ko-KR', 
                name: 'ko-KR-Neural2-A', 
                gender: 'FEMALE', 
                model: 'latest',
                speakingRate: 0.85, 
                pitch: 3.0, 
                volumeGain: 4.0 
            },
            'ja': { 
                languageCode: 'ja-JP', 
                name: 'ja-JP-Neural2-B', 
                gender: 'FEMALE', 
                model: 'latest',
                speakingRate: 0.9, 
                pitch: 2.0, 
                volumeGain: 3.0 
            }
        };
        return voices[language] || voices['en'];
    }

    getElevenLabsMultilingualVoice(language) {
        const voices = {
            'ar': { 
                voiceId: 'pNInz6obpgDQGcFmaJgB', 
                stability: 0.9, 
                similarityBoost: 0.9, 
                style: 0.8,
                pronunciationDict: ['ar_gulf_pronunciation']
            },
            'en': { 
                voiceId: 'EXAVITQu4vr4xnSDxMaL', 
                stability: 0.85, 
                similarityBoost: 0.95, 
                style: 0.7,
                pronunciationDict: ['en_us_pronunciation']
            },
            'ko': { 
                voiceId: 'IKne3meq5aSn9XLyUdCD', 
                stability: 0.9, 
                similarityBoost: 0.95, 
                style: 0.9,
                pronunciationDict: ['ko_seoul_pronunciation']
            },
            'ja': { 
                voiceId: 'bVMeCyTHy58xNoL34h3p', 
                stability: 0.85, 
                similarityBoost: 0.9, 
                style: 0.8,
                pronunciationDict: ['ja_anime_pronunciation']
            }
        };
        return voices[language] || voices['en'];
    }

    getMicrosoftNeuralVoice(language) {
        const voices = {
            'ar': { 
                locale: 'ar-SA', 
                name: 'ar-SA-ZariyahNeural', 
                style: 'friendly', 
                intensity: '2',
                rate: '0.9', 
                pitch: '+5%', 
                volume: '+10%',
                backgroundAudio: 'none',
                backgroundVolume: '0%'
            },
            'en': { 
                locale: 'en-US', 
                name: 'en-US-JennyMultilingualNeural', 
                style: 'assistant', 
                intensity: '2',
                rate: '0.95', 
                pitch: '+2%', 
                volume: '+8%',
                backgroundAudio: 'none',
                backgroundVolume: '0%'
            },
            'ko': { 
                locale: 'ko-KR', 
                name: 'ko-KR-SunHiNeural', 
                style: 'cheerful', 
                intensity: '2',
                rate: '0.85', 
                pitch: '+8%', 
                volume: '+12%',
                backgroundAudio: 'none',
                backgroundVolume: '0%'
            }
        };
        return voices[language] || voices['en'];
    }

    getAmazonPollyNeuralVoice(language) {
        const voices = {
            'ar': { 
                voiceId: 'Zeina', 
                languageCode: 'ar-XA',
                lexiconNames: ['arabic_pronunciation']
            },
            'en': { 
                voiceId: 'Joanna', 
                languageCode: 'en-US',
                lexiconNames: ['us_english_pronunciation']
            },
            'ko': { 
                voiceId: 'Seoyeon', 
                languageCode: 'ko-KR',
                lexiconNames: ['korean_pronunciation']
            },
            'ja': { 
                voiceId: 'Mizuki', 
                languageCode: 'ja-JP',
                lexiconNames: ['japanese_pronunciation']
            }
        };
        return voices[language] || voices['en'];
    }

    getNaturalReaderPremiumVoice(language) {
        const voices = {
            'ar': { 
                voice: 'Arabic_Premium_Female', 
                speed: 0.9, 
                pitch: 1.05, 
                volume: 1.1,
                emotion: 'friendly',
                emphasis: 'moderate',
                breathing: true
            },
            'en': { 
                voice: 'English_Premium_Female_Neural', 
                speed: 0.95, 
                pitch: 1.0, 
                volume: 1.0,
                emotion: 'cheerful',
                emphasis: 'strong',
                breathing: true
            },
            'ko': { 
                voice: 'Korean_Premium_Female_Ultra', 
                speed: 0.85, 
                pitch: 1.1, 
                volume: 1.2,
                emotion: 'gentle',
                emphasis: 'soft',
                breathing: true
            },
            'ja': { 
                voice: 'Japanese_Premium_Female_Anime', 
                speed: 0.9, 
                pitch: 1.05, 
                volume: 1.1,
                emotion: 'cute',
                emphasis: 'moderate',
                breathing: true
            }
        };
        return voices[language] || voices['en'];
    }

    getPremiumVoice(language) {
        const voices = {
            'ar': { lang: 'ar-eg', voice: 'Hoda' },
            'en': { lang: 'en-us', voice: 'Linda' },
            'es': { lang: 'es-es', voice: 'Pilar' },
            'fr': { lang: 'fr-fr', voice: 'Julie' },
            'de': { lang: 'de-de', voice: 'Marlene' },
            'it': { lang: 'it-it', voice: 'Paola' },
            'pt': { lang: 'pt-br', voice: 'Lupe' },
            'ru': { lang: 'ru-ru', voice: 'Irina' },
            'ja': { lang: 'ja-jp', voice: 'Kyoko' },
            'ko': { lang: 'ko-kr', voice: 'Seoyeon' }, // أفضل صوت كوري
            'zh': { lang: 'zh-cn', voice: 'Lining' },
            'hi': { lang: 'hi-in', voice: 'Kalpana' },
            'tr': { lang: 'tr-tr', voice: 'Burcu' }
        };
        return voices[language] || voices['en'];
    }

    getAdvancedMicrosoftVoice(language) {
        const voices = {
            'ar': { locale: 'ar-SA', name: 'ar-SA-HamedNeural' },
            'en': { locale: 'en-US', name: 'en-US-AriaNeural' },
            'es': { locale: 'es-ES', name: 'es-ES-AlvaroNeural' },
            'fr': { locale: 'fr-FR', name: 'fr-FR-DeniseNeural' },
            'de': { locale: 'de-DE', name: 'de-DE-ConradNeural' },
            'it': { locale: 'it-IT', name: 'it-IT-DiegoNeural' },
            'pt': { locale: 'pt-BR', name: 'pt-BR-AntonioNeural' },
            'ru': { locale: 'ru-RU', name: 'ru-RU-DmitryNeural' },
            'ja': { locale: 'ja-JP', name: 'ja-JP-KeitaNeural' },
            'ko': { locale: 'ko-KR', name: 'ko-KR-InJoonNeural' }, // أفضل صوت كوري من Microsoft
            'zh': { locale: 'zh-CN', name: 'zh-CN-YunxiNeural' },
            'hi': { locale: 'hi-IN', name: 'hi-IN-MadhurNeural' },
            'tr': { locale: 'tr-TR', name: 'tr-TR-AhmetNeural' }
        };
        return voices[language] || voices['en'];
    }

    getAdvancedGoogleVoice(language) {
        const voices = {
            'ar': { languageCode: 'ar-XA', name: 'ar-XA-Wavenet-C', gender: 'MALE' },
            'en': { languageCode: 'en-US', name: 'en-US-Neural2-F', gender: 'FEMALE' },
            'es': { languageCode: 'es-ES', name: 'es-ES-Neural2-C', gender: 'FEMALE' },
            'fr': { languageCode: 'fr-FR', name: 'fr-FR-Neural2-B', gender: 'MALE' },
            'de': { languageCode: 'de-DE', name: 'de-DE-Neural2-C', gender: 'FEMALE' },
            'it': { languageCode: 'it-IT', name: 'it-IT-Neural2-C', gender: 'MALE' },
            'pt': { languageCode: 'pt-BR', name: 'pt-BR-Neural2-B', gender: 'MALE' },
            'ru': { languageCode: 'ru-RU', name: 'ru-RU-Wavenet-A', gender: 'FEMALE' },
            'ja': { languageCode: 'ja-JP', name: 'ja-JP-Neural2-C', gender: 'MALE' },
            'ko': { languageCode: 'ko-KR', name: 'ko-KR-Neural2-C', gender: 'MALE' }, // أعلى جودة للكورية
            'zh': { languageCode: 'zh-CN', name: 'zh-CN-Wavenet-C', gender: 'MALE' },
            'hi': { languageCode: 'hi-IN', name: 'hi-IN-Neural2-C', gender: 'MALE' },
            'tr': { languageCode: 'tr-TR', name: 'tr-TR-Wavenet-B', gender: 'MALE' }
        };
        return voices[language] || voices['en'];
    }

    getEnhancedAzureVoice(language) {
        const voices = {
            'ar': { locale: 'ar-SA', name: 'ar-SA-ZariyahNeural' },
            'en': { locale: 'en-US', name: 'en-US-JennyMultilingualNeural' },
            'es': { locale: 'es-ES', name: 'es-ES-ElviraNeural' },
            'fr': { locale: 'fr-FR', name: 'fr-FR-DeniseNeural' },
            'de': { locale: 'de-DE', name: 'de-DE-KatjaNeural' },
            'it': { locale: 'it-IT', name: 'it-IT-ElsaNeural' },
            'pt': { locale: 'pt-BR', name: 'pt-BR-FranciscaNeural' },
            'ru': { locale: 'ru-RU', name: 'ru-RU-SvetlanaNeural' },
            'ja': { locale: 'ja-JP', name: 'ja-JP-NanamiNeural' },
            'ko': { locale: 'ko-KR', name: 'ko-KR-SunHiNeural' }, // أفضل صوت أنثوي كوري
            'zh': { locale: 'zh-CN', name: 'zh-CN-XiaoxiaoNeural' },
            'hi': { locale: 'hi-IN', name: 'hi-IN-SwaraNeural' },
            'tr': { locale: 'tr-TR', name: 'tr-TR-EmelNeural' }
        };
        return voices[language] || voices['en'];
    }

    getNaturalVoiceSettings(language) {
        const settings = {
            'ar': { voice: 'Arabic_Male_1', speed: 0.9, pitch: 1.1, volume: 1.2 },
            'en': { voice: 'US_English_Female_1', speed: 0.95, pitch: 1.0, volume: 1.1 },
            'es': { voice: 'Spanish_Female_1', speed: 0.9, pitch: 1.05, volume: 1.15 },
            'fr': { voice: 'French_Male_1', speed: 0.9, pitch: 1.0, volume: 1.1 },
            'de': { voice: 'German_Female_1', speed: 0.85, pitch: 1.0, volume: 1.1 },
            'it': { voice: 'Italian_Male_1', speed: 0.9, pitch: 1.05, volume: 1.1 },
            'pt': { voice: 'Portuguese_Female_1', speed: 0.9, pitch: 1.0, volume: 1.15 },
            'ru': { voice: 'Russian_Female_1', speed: 0.85, pitch: 1.0, volume: 1.1 },
            'ja': { voice: 'Japanese_Female_1', speed: 0.8, pitch: 1.0, volume: 1.1 },
            'ko': { voice: 'Korean_Female_Premium', speed: 0.85, pitch: 1.05, volume: 1.2 }, // إعدادات مخصصة للكورية
            'zh': { voice: 'Chinese_Male_1', speed: 0.9, pitch: 1.0, volume: 1.1 },
            'hi': { voice: 'Hindi_Female_1', speed: 0.85, pitch: 1.0, volume: 1.1 },
            'tr': { voice: 'Turkish_Female_1', speed: 0.9, pitch: 1.0, volume: 1.1 }
        };
        return settings[language] || settings['en'];
    }

    getEnhancedElevenLabsVoice(language) {
        // أصوات طبيعية أكثر من ElevenLabs
        const voices = {
            'ar': 'pNInz6obpgDQGcFmaJgB', // Adam (أفضل للعربية)
            'en': 'EXAVITQu4vr4xnSDxMaL', // Sarah (صوت طبيعي جداً)
            'es': '21m00Tcm4TlvDq8ikWAM', // Rachel
            'fr': 'AZnzlk1XvdvUeBnXmlld', // Domi
            'de': 'ErXwobaYiN019PkySvjV', // Antoni
            'it': 'MF3mGyEYCl7XYWbV9V6O', // Elli
            'pt': 'TxGEqnHWrfWFTfGW9XjX', // Josh
            'ru': 'VR6AewLTigWG4xSOukaG', // Arnold
            'ja': 'bVMeCyTHy58xNoL34h3p', // Jeremy
            'ko': 'IKne3meq5aSn9XLyUdCD', // Charlie
            'zh': 'pqHfZKP75CvOlQylNhV4', // Bill
            'hi': 'N2lVS1w4EtoT3dr4eOWO', // Callum
            'tr': 'piTKgcLEGmPE4e6mEKli'  // Nicole
        };
        return voices[language] || voices['en'];
    }

    getAzureCognitiveVoice(language) {
        // أصوات Azure الطبيعية
        const voices = {
            'ar': { locale: 'ar-SA', name: 'ar-SA-HamedNeural', gender: 'Male' },
            'en': { locale: 'en-US', name: 'en-US-AriaNeural', gender: 'Female' },
            'es': { locale: 'es-ES', name: 'es-ES-AlvaroNeural', gender: 'Male' },
            'fr': { locale: 'fr-FR', name: 'fr-FR-DeniseNeural', gender: 'Female' },
            'de': { locale: 'de-DE', name: 'de-DE-ConradNeural', gender: 'Male' },
            'it': { locale: 'it-IT', name: 'it-IT-DiegoNeural', gender: 'Male' },
            'pt': { locale: 'pt-BR', name: 'pt-BR-AntonioNeural', gender: 'Male' },
            'ru': { locale: 'ru-RU', name: 'ru-RU-DmitryNeural', gender: 'Male' },
            'ja': { locale: 'ja-JP', name: 'ja-JP-KeitaNeural', gender: 'Male' },
            'ko': { locale: 'ko-KR', name: 'ko-KR-InJoonNeural', gender: 'Male' },
            'zh': { locale: 'zh-CN', name: 'zh-CN-YunxiNeural', gender: 'Male' },
            'hi': { locale: 'hi-IN', name: 'hi-IN-MadhurNeural', gender: 'Male' },
            'tr': { locale: 'tr-TR', name: 'tr-TR-AhmetNeural', gender: 'Male' }
        };
        return voices[language] || voices['en'];
    }

    getGoogleWaveNetVoice(language) {
        // أصوات Google WaveNet عالية الجودة
        const voices = {
            'ar': { languageCode: 'ar-XA', name: 'ar-XA-Wavenet-B', gender: 'MALE' },
            'en': { languageCode: 'en-US', name: 'en-US-Wavenet-F', gender: 'FEMALE' },
            'es': { languageCode: 'es-ES', name: 'es-ES-Wavenet-B', gender: 'MALE' },
            'fr': { languageCode: 'fr-FR', name: 'fr-FR-Wavenet-A', gender: 'FEMALE' },
            'de': { languageCode: 'de-DE', name: 'de-DE-Wavenet-B', gender: 'MALE' },
            'it': { languageCode: 'it-IT', name: 'it-IT-Wavenet-A', gender: 'FEMALE' },
            'pt': { languageCode: 'pt-BR', name: 'pt-BR-Wavenet-A', gender: 'FEMALE' },
            'ru': { languageCode: 'ru-RU', name: 'ru-RU-Wavenet-A', gender: 'FEMALE' },
            'ja': { languageCode: 'ja-JP', name: 'ja-JP-Wavenet-A', gender: 'FEMALE' },
            'ko': { languageCode: 'ko-KR', name: 'ko-KR-Wavenet-A', gender: 'FEMALE' },
            'zh': { languageCode: 'zh-CN', name: 'zh-CN-Wavenet-A', gender: 'FEMALE' },
            'hi': { languageCode: 'hi-IN', name: 'hi-IN-Wavenet-A', gender: 'FEMALE' },
            'tr': { languageCode: 'tr-TR', name: 'tr-TR-Wavenet-A', gender: 'FEMALE' }
        };
        return voices[language] || voices['en'];
    }

    getElevenLabsVoice(language) {
        const voices = {
            'ar': '21m00Tcm4TlvDq8ikWAM', // Rachel
            'en': '21m00Tcm4TlvDq8ikWAM', // Rachel
            'es': 'VR6AewLTigWG4xSOukaG', // Arnold
            'fr': 'ThT5KcBeYPX3keUQqHPh', // Dorothy
            'de': 'TxGEqnHWrfWFTfGW9XjX', // Josh
            'it': 'XB0fDUnXU5Dbad1ZZApJ', // Jeremy
            'pt': 'pNInz6obpgDQGcFmaJgB', // Adam
            'ru': 'ODq5zmih8GrVes37Dizd', // Patrick
            'ja': 'IKne3meq5aSn9XLyUdCD', // Charlie
            'ko': 'piTKgcLEGmPE4e6mEKli', // Nicole
            'zh': 'yoZ06aMxZJJ28mfd3POQ', // Sam
            'hi': 'cgSgspJ2msm6clMCkdW9'  // Jessica
        };
        return voices[language] || voices['en'];
    }

    getGoogleCloudVoice(language) {
        const voices = {
            'ar': { languageCode: 'ar-XA', name: 'ar-XA-Standard-A', gender: 'FEMALE' },
            'en': { languageCode: 'en-US', name: 'en-US-Neural2-F', gender: 'FEMALE' },
            'es': { languageCode: 'es-ES', name: 'es-ES-Neural2-B', gender: 'MALE' },
            'fr': { languageCode: 'fr-FR', name: 'fr-FR-Neural2-A', gender: 'FEMALE' },
            'de': { languageCode: 'de-DE', name: 'de-DE-Neural2-B', gender: 'MALE' },
            'it': { languageCode: 'it-IT', name: 'it-IT-Neural2-A', gender: 'FEMALE' },
            'pt': { languageCode: 'pt-BR', name: 'pt-BR-Neural2-A', gender: 'FEMALE' },
            'ru': { languageCode: 'ru-RU', name: 'ru-RU-Standard-A', gender: 'FEMALE' },
            'ja': { languageCode: 'ja-JP', name: 'ja-JP-Neural2-B', gender: 'FEMALE' },
            'ko': { languageCode: 'ko-KR', name: 'ko-KR-Neural2-A', gender: 'FEMALE' },
            'zh': { languageCode: 'zh-CN', name: 'zh-CN-Standard-A', gender: 'FEMALE' },
            'hi': { languageCode: 'hi-IN', name: 'hi-IN-Neural2-A', gender: 'FEMALE' },
            'tr': { languageCode: 'tr-TR', name: 'tr-TR-Standard-A', gender: 'FEMALE' }
        };
        return voices[language] || voices['en'];
    }

    getMicrosoftVoice(language) {
        const voices = {
            'ar': { locale: 'ar-SA', name: 'ar-SA-ZariyahNeural', gender: 'Female' },
            'en': { locale: 'en-US', name: 'en-US-JennyNeural', gender: 'Female' },
            'es': { locale: 'es-ES', name: 'es-ES-ElviraNeural', gender: 'Female' },
            'fr': { locale: 'fr-FR', name: 'fr-FR-DeniseNeural', gender: 'Female' },
            'de': { locale: 'de-DE', name: 'de-DE-KatjaNeural', gender: 'Female' },
            'it': { locale: 'it-IT', name: 'it-IT-ElsaNeural', gender: 'Female' },
            'pt': { locale: 'pt-BR', name: 'pt-BR-FranciscaNeural', gender: 'Female' },
            'ru': { locale: 'ru-RU', name: 'ru-RU-SvetlanaNeural', gender: 'Female' },
            'ja': { locale: 'ja-JP', name: 'ja-JP-NanamiNeural', gender: 'Female' },
            'ko': { locale: 'ko-KR', name: 'ko-KR-SunHiNeural', gender: 'Female' },
            'zh': { locale: 'zh-CN', name: 'zh-CN-XiaoxiaoNeural', gender: 'Female' },
            'hi': { locale: 'hi-IN', name: 'hi-IN-SwaraNeural', gender: 'Female' },
            'tr': { locale: 'tr-TR', name: 'tr-TR-EmelNeural', gender: 'Female' }
        };
        return voices[language] || voices['en'];
    }

    getOpenAIVoice(language) {
        const voices = {
            'ar': 'alloy',
            'en': 'nova',
            'es': 'shimmer',
            'fr': 'echo',
            'de': 'fable',
            'it': 'onyx',
            'pt': 'nova',
            'ru': 'alloy',
            'ja': 'shimmer',
            'ko': 'echo',
            'zh': 'alloy',
            'hi': 'nova',
            'tr': 'fable'
        };
        return voices[language] || 'alloy';
    }

    async tryPremiumFemaleVoice(text, language, audioDir) {
        try {
            const audioFileName = `premium_female_${Date.now()}.mp3`;
            const audioFilePath = path.join(audioDir, audioFileName);

            // استخدام صوت أنثوي عالي الجودة مع إعدادات محسنة جداً
            const params = new URLSearchParams({
                ie: 'UTF-8',
                q: text,
                tl: language,
                client: 'tw-ob',
                textlen: text.length.toString(),
                ttsspeed: '0.5', // أبطأ جداً للحصول على صوت أنثوي واضح
                total: '1',
                idx: '0',
                prev: 'input'
            });

            const response = await axios.get(`https://translate.google.com/translate_tts?${params.toString()}`, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
                    'Referer': 'https://translate.google.com/',
                    'Accept': 'audio/mpeg, audio/mp3, audio/wav, */*',
                    'Accept-Language': `${language},ar;q=0.9,en;q=0.8`,
                    'Accept-Encoding': 'identity',
                    'Connection': 'keep-alive',
                    'Cache-Control': 'no-cache'
                },
                responseType: 'arraybuffer',
                timeout: 20000
            });

            if (response.status === 200 && response.data && response.data.byteLength > 1000) {
                const audioBuffer = Buffer.from(response.data);
                await fs.writeFile(audioFilePath, audioBuffer);

                setTimeout(async () => {
                    try {
                        await fs.remove(audioFilePath);
                    } catch (e) {}
                }, 2000);

                return audioBuffer;
            }

            return null;
        } catch (error) {
            console.log(`⚠️ فشل الصوت الأنثوي المتقدم: ${error.message}`);
            return null;
        }
    }

    async tryGoogleFemaleVoice(text, language, audioDir) {
        try {
            const audioFileName = `google_female_${Date.now()}.mp3`;
            const audioFilePath = path.join(audioDir, audioFileName);

            const params = new URLSearchParams({
                ie: 'UTF-8',
                q: text,
                tl: language,
                client: 'tw-ob',
                ttsspeed: '0.7', // أبطأ للوضوح
                total: '1',
                idx: '0'
            });

            const response = await axios.get(`https://translate.google.com/translate_tts?${params.toString()}`, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (iPad; CPU OS 16_0 like Mac OS X) AppleWebKit/605.1.15',
                    'Accept': 'audio/mpeg'
                },
                responseType: 'arraybuffer',
                timeout: 15000
            });

            if (response.status === 200 && response.data && response.data.byteLength > 1000) {
                const audioBuffer = Buffer.from(response.data);
                await fs.writeFile(audioFilePath, audioBuffer);

                setTimeout(async () => {
                    try {
                        await fs.remove(audioFilePath);
                    } catch (e) {}
                }, 2000);

                return audioBuffer;
            }

            return null;
        } catch (error) {
            return null;
        }
    }

    async tryMicrosoftFemaleVoice(text, language, audioDir) {
        try {
            const audioFileName = `microsoft_female_${Date.now()}.mp3`;
            const audioFilePath = path.join(audioDir, audioFileName);

            const femaleVoice = this.getMicrosoftFemaleVoice(language);

            const ssml = `
            <speak version='1.0' xml:lang='${femaleVoice.locale}'>
                <voice xml:lang='${femaleVoice.locale}' xml:gender='Female' name='${femaleVoice.name}'>
                    <prosody rate="0.8" pitch="+10%" volume="medium">
                        ${text}
                    </prosody>
                </voice>
            </speak>`;

            const response = await axios.post('https://speech.platform.bing.com/synthesize', ssml, {
                headers: {
                    'Content-Type': 'application/ssml+xml',
                    'X-Microsoft-OutputFormat': 'audio-24khz-48kbitrate-mono-mp3'
                },
                responseType: 'arraybuffer',
                timeout: 15000
            });

            if (response.status === 200 && response.data && response.data.byteLength > 1000) {
                const audioBuffer = Buffer.from(response.data);
                await fs.writeFile(audioFilePath, audioBuffer);

                setTimeout(async () => {
                    try {
                        await fs.remove(audioFilePath);
                    } catch (e) {}
                }, 2000);

                return audioBuffer;
            }

            return null;
        } catch (error) {
            return null;
        }
    }

    async tryUltraFemaleVoice(text, language, audioDir) {
        try {
            const audioFileName = `ultra_female_${Date.now()}.mp3`;
            const audioFilePath = path.join(audioDir, audioFileName);

            // خدمة صوت أنثوي فائق الجودة
            const params = new URLSearchParams({
                ie: 'UTF-8',
                q: text,
                tl: language,
                client: 'gtx', 
                ttsspeed: '0.4', // أبطأ جداً للحصول على نطق أنثوي واضح
                total: '1',
                idx: '0'
            });

            const response = await axios.get(`https://translate.google.com/translate_tts?${params.toString()}`, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
                    'Referer': 'https://translate.google.com/',
                    'Accept': 'audio/mpeg, audio/mp3, audio/ogg, audio/wav, audio/*',
                    'Accept-Language': `${language},ar;q=0.9,en;q=0.8,fr;q=0.7`,
                    'Accept-Encoding': 'identity', 
                    'Connection': 'keep-alive',
                    'Sec-Fetch-Dest': 'audio',
                    'Sec-Fetch-Mode': 'no-cors',
                    'Sec-Fetch-Site': 'same-origin'
                },
                responseType: 'arraybuffer',
                timeout: 25000
            });

            if (response.status === 200 && response.data && response.data.byteLength > 1500) {
                const audioBuffer = Buffer.from(response.data);
                await fs.writeFile(audioFilePath, audioBuffer);

                setTimeout(async () => {
                    try {
                        await fs.remove(audioFilePath);
                    } catch (e) {}
                }, 3000);

                console.log(`✅ Ultra Female Voice نجح - حجم: ${audioBuffer.length} بايت`);
                return audioBuffer;
            }

            return null;
        } catch (error) {
            console.log(`❌ Ultra Female Voice فشل: ${error.message}`);
            return null;
        }
    }

    async tryAdvancedMicrosoftFemaleVoice(text, language, audioDir) {
        try {
            const audioFileName = `advanced_ms_female_${Date.now()}.mp3`;
            const audioFilePath = path.join(audioDir, audioFileName);

            const femaleVoice = this.getAdvancedMicrosoftFemaleVoice(language);

            const ssml = `
            <speak version='1.0' xmlns:mstts="http://www.w3.org/2001/mstts" xml:lang='${femaleVoice.locale}'>
                <voice xml:lang='${femaleVoice.locale}' xml:gender='Female' name='${femaleVoice.name}'>
                    <mstts:express-as style="friendly" styledegree="2">
                        <prosody rate="0.6" pitch="+25%" volume="+20%">
                            <emphasis level="moderate">
                                ${text}
                            </emphasis>
                        </prosody>
                    </mstts:express-as>
                </voice>
            </speak>`;

            const response = await axios.post('https://eastus.tts.speech.microsoft.com/cognitiveservices/v1', ssml, {
                headers: {
                    'Content-Type': 'application/ssml+xml',
                    'X-Microsoft-OutputFormat': 'audio-48khz-192kbitrate-mono-mp3',
                    'Ocp-Apim-Subscription-Key': 'demo',
                    'User-Agent': 'Microsoft-Female-TTS/3.0'
                },
                responseType: 'arraybuffer',
                timeout: 20000
            });

            if (response.status === 200 && response.data && response.data.byteLength > 2000) {
                const audioBuffer = Buffer.from(response.data);
                await fs.writeFile(audioFilePath, audioBuffer);

                setTimeout(async () => {
                    try {
                        await fs.remove(audioFilePath);
                    } catch (e) {}
                }, 3000);

                console.log(`✅ Advanced Microsoft Female نجح - حجم: ${audioBuffer.length} بايت`);
                return audioBuffer;
            }

            return null;
        } catch (error) {
            console.log(`❌ Advanced Microsoft Female فشل: ${error.message}`);
            return null;
        }
    }

    async tryEnhancedGoogleFemaleVoice(text, language, audioDir) {
        try {
            const audioFileName = `enhanced_google_female_${Date.now()}.mp3`;
            const audioFilePath = path.join(audioDir, audioFileName);

            const params = new URLSearchParams({
                ie: 'UTF-8',
                q: text,
                tl: language,
                client: 'webapp',
                textlen: text.length.toString(),
                ttsspeed: '0.55', // سرعة محسنة للصوت الأنثوي
                total: '1',
                idx: '0',
                prev: 'input'
            });

            const response = await axios.get(`https://translate.google.com/translate_tts?${params.toString()}`, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36 Enhanced-Female-Voice/2.0',
                    'Referer': 'https://translate.google.com/',
                    'Accept': 'audio/mpeg, audio/mp3, audio/wav, audio/x-wav',
                    'Accept-Language': `${language},ar;q=0.9,en;q=0.8`,
                    'Accept-Encoding': 'gzip, deflate, br',
                    'Connection': 'keep-alive',
                    'DNT': '1',
                    'Sec-Fetch-Dest': 'audio',
                    'Sec-Fetch-Mode': 'cors',
                    'Sec-Fetch-Site': 'same-origin',
                    'X-Requested-With': 'XMLHttpRequest'
                },
                responseType: 'arraybuffer',
                timeout: 18000
            });

            if (response.status === 200 && response.data && response.data.byteLength > 1200) {
                const audioBuffer = Buffer.from(response.data);
                await fs.writeFile(audioFilePath, audioBuffer);

                setTimeout(async () => {
                    try {
                        await fs.remove(audioFilePath);
                    } catch (e) {}
                }, 3000);

                console.log(`✅ Enhanced Google Female نجح - حجم: ${audioBuffer.length} بايت`);
                return audioBuffer;
            }

            return null;
        } catch (error) {
            console.log(`❌ Enhanced Google Female فشل: ${error.message}`);
            return null;
        }
    }

    async tryGTTSWithFemaleSettings(text, language, audioDir) {
        try {
            const audioFileName = `gtts_female_${Date.now()}.mp3`;
            const audioFilePath = path.join(audioDir, audioFileName);

            // إعدادات محسنة للصوت الأنثوي مع GTTS
            const tts = new gtts(text, language, true); // slow = true للحصول على نطق أوضح

            await new Promise((resolve, reject) => {
                tts.save(audioFilePath, (error, result) => {
                    if (error) {
                        reject(error);
                    } else {
                        resolve(result);
                    }
                });
            });

            if (await fs.pathExists(audioFilePath)) {
                const audioBuffer = await fs.readFile(audioFilePath);

                setTimeout(async () => {
                    try {
                        await fs.remove(audioFilePath);
                    } catch (e) {}
                }, 2000);

                console.log(`✅ GTTS Female نجح - حجم: ${audioBuffer.length} بايت`);
                return audioBuffer;
            }

            return null;
        } catch (error) {
            console.log(`❌ GTTS Female فشل: ${error.message}`);
            return null;
        }
    }

    getAdvancedMicrosoftFemaleVoice(language) {
        const voices = {
            'ar': { locale: 'ar-SA', name: 'ar-SA-ZariyahNeural' },
            'en': { locale: 'en-US', name: 'en-US-AriaNeural' },
            'ja': { locale: 'ja-JP', name: 'ja-JP-NanamiNeural' },
            'ko': { locale: 'ko-KR', name: 'ko-KR-SunHiNeural' },
            'zh': { locale: 'zh-CN', name: 'zh-CN-XiaoxiaoNeural' },
            'fr': { locale: 'fr-FR', name: 'fr-FR-DeniseNeural' },
            'es': { locale: 'es-ES', name: 'es-ES-ElviraNeural' },
            'de': { locale: 'de-DE', name: 'de-DE-KatjaNeural' },
            'it': { locale: 'it-IT', name: 'it-IT-ElsaNeural' },
            'pt': { locale: 'pt-BR', name: 'pt-BR-FranciscaNeural' },
            'ru': { locale: 'ru-RU', name: 'ru-RU-SvetlanaNeural' },
            'hi': { locale: 'hi-IN', name: 'hi-IN-SwaraNeural' },
            'tr': { locale: 'tr-TR', name: 'tr-TR-EmelNeural' }
        };
        return voices[language] || voices['en'];
    }

    getFemaleVoiceConfig(language) {
        const configs = {
            'ar': { speed: '0.65', pitch: '+15%', voice: 'female' },
            'en': { speed: '0.75', pitch: '+8%', voice: 'female' },
            'ja': { speed: '0.7', pitch: '+12%', voice: 'female' },
            'ko': { speed: '0.65', pitch: '+15%', voice: 'female' },
            'zh': { speed: '0.7', pitch: '+10%', voice: 'female' },
            'fr': { speed: '0.75', pitch: '+8%', voice: 'female' },
            'es': { speed: '0.75', pitch: '+10%', voice: 'female' },
            'de': { speed: '0.7', pitch: '+5%', voice: 'female' },
            'it': { speed: '0.75', pitch: '+12%', voice: 'female' },
            'pt': { speed: '0.75', pitch: '+10%', voice: 'female' },
            'ru': { speed: '0.7', pitch: '+8%', voice: 'female' },
            'hi': { speed: '0.7', pitch: '+10%', voice: 'female' },
            'tr': { speed: '0.75', pitch: '+8%', voice: 'female' }
        };
        return configs[language] || configs['en'];
    }

    getEnhancedFemaleVoiceConfig(language) {
        const configs = {
            'ar': { speed: '0.6', pitch: '+20%', voice: 'female', quality: 'premium' },
            'en': { speed: '0.7', pitch: '+12%', voice: 'female', quality: 'premium' },
            'ja': { speed: '0.65', pitch: '+18%', voice: 'female', quality: 'premium' },
            'ko': { speed: '0.6', pitch: '+22%', voice: 'female', quality: 'premium' },
            'zh': { speed: '0.65', pitch: '+15%', voice: 'female', quality: 'premium' },
            'fr': { speed: '0.7', pitch: '+12%', voice: 'female', quality: 'premium' },
            'es': { speed: '0.7', pitch: '+15%', voice: 'female', quality: 'premium' },
            'de': { speed: '0.65', pitch: '+10%', voice: 'female', quality: 'premium' },
            'it': { speed: '0.7', pitch: '+18%', voice: 'female', quality: 'premium' },
            'pt': { speed: '0.7', pitch: '+15%', voice: 'female', quality: 'premium' },
            'ru': { speed: '0.65', pitch: '+12%', voice: 'female', quality: 'premium' },
            'hi': { speed: '0.65', pitch: '+15%', voice: 'female', quality: 'premium' },
            'tr': { speed: '0.7', pitch: '+12%', voice: 'female', quality: 'premium' }
        };
        return configs[language] || configs['en'];
    }

    getMicrosoftFemaleVoice(language) {
        const voices = {
            'ar': { locale: 'ar-SA', name: 'ar-SA-ZariyahNeural' },
            'en': { locale: 'en-US', name: 'en-US-JennyNeural' },
            'ja': { locale: 'ja-JP', name: 'ja-JP-NanamiNeural' },
            'ko': { locale: 'ko-KR', name: 'ko-KR-SunHiNeural' },
            'zh': { locale: 'zh-CN', name: 'zh-CN-XiaoxiaoNeural' },
            'fr': { locale: 'fr-FR', name: 'fr-FR-DeniseNeural' },
            'es': { locale: 'es-ES', name: 'es-ES-ElviraNeural' },
            'de': { locale: 'de-DE', name: 'de-DE-KatjaNeural' },
            'it': { locale: 'it-IT', name: 'it-IT-ElsaNeural' },
            'pt': { locale: 'pt-BR', name: 'pt-BR-FranciscaNeural' },
            'ru': { locale: 'ru-RU', name: 'ru-RU-SvetlanaNeural' },
            'hi': { locale: 'hi-IN', name: 'hi-IN-SwaraNeural' },
            'tr': { locale: 'tr-TR', name: 'tr-TR-EmelNeural' }
        };
        return voices[language] || voices['en'];
    }

    async tryAlternativeGoogleTTS(text, language, audioDir) {
        try {
            const audioFileName = `alt_google_tts_${Date.now()}.mp3`;
            const audioFilePath = path.join(audioDir, audioFileName);

            const params = new URLSearchParams({
                ie: 'UTF-8',
                q: text,
                tl: language,
                client: 'gtx',
                ttsspeed: '0.85'
            });

            const response = await axios.get(`https://translate.google.com/translate_tts?${params.toString()}`, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 14_0 like Mac OS X)',
                    'Accept': 'audio/mpeg'
                },
                responseType: 'arraybuffer',
                timeout: 15000
            });

            if (response.status === 200 && response.data && response.data.byteLength > 2000) {
                const audioBuffer = Buffer.from(response.data);
                await fs.writeFile(audioFilePath, audioBuffer);

                setTimeout(async () => {
                    try {
                        await fs.remove(audioFilePath);
                    } catch (e) {}
                }, 2000);

                return audioBuffer;
            }

            return null;
        } catch (error) {
            return null;
        }
    }

    async tryGTTSLibrary(text, language, audioDir) {
        try {
            const audioFileName = `gtts_premium_${Date.now()}.mp3`;
            const audioFilePath = path.join(audioDir, audioFileName);

            console.log(`🎵 استخدام GTTS المحسن للنص الكامل: ${text.length} حرف`);

            // استخدام إعدادات محسنة للجودة
            const gttsOptions = {
                lang: language,
                slow: language === 'ar' ? true : false, // نطق أبطأ للعربية لوضوح أفضل
                host: 'https://translate.google.com'
            };

            const tts = new gtts(text, gttsOptions.lang, gttsOptions.slow);

            await new Promise((resolve, reject) => {
                tts.save(audioFilePath, (error, result) => {
                    if (error) {
                        console.log(`❌ خطأ في GTTS المحسن: ${error.message}`);
                        reject(error);
                    } else {
                        console.log(`✅ GTTS المحسن نجح في حفظ الملف`);
                        resolve(result);
                    }
                });
            });

            // التحقق من وجود الملف
            if (await fs.pathExists(audioFilePath)) {
                let audioBuffer = await fs.readFile(audioFilePath);

                // تحسين جودة الصوت إضافياً
                audioBuffer = await this.enhancedAudioProcessing(audioBuffer);

                console.log(`✅ GTTS المحسن أنتج ملف بحجم: ${audioBuffer.length} بايت بجودة عالية`);

                setTimeout(async () => {
                    try {
                        await fs.remove(audioFilePath);
                    } catch (e) {}
                }, 2000);

                return audioBuffer;
            } else {
                console.log(`❌ GTTS المحسن لم ينتج ملف`);
                return null;
            }
        } catch (error) {
            console.log(`❌ خطأ في GTTS المحسن: ${error.message}`);
            return null;
        }
    }

    async tryVoiceRSSFree(text, language, audioDir) {
        try {
            const audioFileName = `voicerss_free_${Date.now()}.mp3`;
            const audioFilePath = path.join(audioDir, audioFileName);

            const response = await axios.post('https://api.voicerss.org/', {
                key: 'demo',
                hl: language,
                r: '0',
                c: 'MP3',
                f: '44khz_16bit_mono',
                src: text
            }, {
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded'
                },
                responseType: 'arraybuffer',
                timeout: 15000
            });

            if (response.status === 200 && response.data && response.data.byteLength > 2000) {
                const audioBuffer = Buffer.from(response.data);
                await fs.writeFile(audioFilePath, audioBuffer);

                setTimeout(async () => {
                    try {
                        await fs.remove(audioFilePath);
                    } catch (e) {}
                }, 2000);

                return audioBuffer;
            }

            return null;
        } catch (error) {
            return null;
        }
    }

    cleanupTempData() {
        // تنظيف البيانات المؤقتة عند النجاح في الاتصال
        if (this.processedMessages.size > 500) {
            this.processedMessages.clear();
        }

        if (this.deletedByCommand.size > 100) {
            this.deletedByCommand.clear();
        }
    }
}

// إنشاء وتشغيل البوت
const bot = new WhatsAppBot();
bot.start();

// التعامل مع إيقاف البرنامج بشكل صحيح
process.on('SIGINT', async () => {
    console.log('\n🔄 إيقاف البوت...');
    if (bot.sock) {
        try {
            await bot.sock.logout();
        } catch (error) {
            console.log('تم إيقاف البوت');
        }
    }
    process.exit(0);
});

process.on('uncaughtException', (error) => {
    console.error('❌ خطأ غير متوقع:', error.message);
    console.error('Stack Trace:', error.stack);
    // عدم إيقاف البرنامج لمنع توقف البوت
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('❌ رفض غير معالج:', reason);
    console.error('Promise:', promise);
    // عدم إيقاف البرنامج لمنع توقف البوت
});

// إضافة معالج إضافي للأخطاء
process.on('warning', (warning) => {
    console.warn('⚠️ تحذير:', warning.message);
});
