require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const moment = require('moment');
const { Op } = require('sequelize'); 
const { createCanvas } = require('canvas'); 


const { User, Group, Task, Subject, Lesson } = require('./models');
const setupCron = require('./services/cron');

const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });
setupCron(bot);

const userStates = {}; 

const isAdmin = (id) => id.toString() === process.env.ADMIN_ID;
const getRoleText = (role) => role === 'admin' ? 'Администратор' : role === 'curator' ? 'Куратор' : 'Студент';

const DAYS = { 1: 'Понедельник', 2: 'Вторник', 3: 'Среда', 4: 'Четверг', 5: 'Пятница', 6: 'Суббота', 7: 'Воскресенье' };
const WORK_DAYS_KEYS = ['1', '2', '3', '4', '5', '6']; 
const SCHEDULE_TYPES_NAMES = { 'std': 'Обычный (пн-пт)', 'tue': 'Вторник (с Кл.час)', 'sat': 'Суббота', 'short45': 'Сокр. 45 мин', 'short60': 'Сокр. 60 мин' };

const STATIC_SCHEDULES = {
    'std': [{num:1,start:'08:30',end:'10:00'},{num:2,start:'10:10',end:'11:40'},{num:3,start:'12:20',end:'13:50'},{num:4,start:'14:00',end:'15:30'},{num:5,start:'15:40',end:'17:10'},{num:6,start:'17:20',end:'18:50'},{num:7,start:'19:00',end:'20:30'}],
    'tue': [{num:1,start:'08:30',end:'10:00'},{num:2,start:'10:10',end:'11:40'},{num:3,start:'13:10',end:'14:40'},{num:4,start:'14:50',end:'16:20'},{num:5,start:'16:30',end:'18:00'}],
    'sat': [{num:1,start:'08:30',end:'10:00'},{num:2,start:'10:10',end:'11:40'},{num:3,start:'12:10',end:'13:40'},{num:4,start:'13:50',end:'15:20'},{num:5,start:'15:30',end:'17:00'}]
};

const generateShortSchedule = (mins) => {
    let t = moment("08:30", "HH:mm");
    const arr = [];
    for (let i = 1; i <= 7; i++) {
        const start = t.format("HH:mm"); t.add(mins, 'm'); const end = t.format("HH:mm");
        arr.push({ num: i, start, end }); t.add(10, 'm'); 
    }
    return arr;
};

const getGroupBells = (group, dayIndex) => {
    let settings = {}; try { settings = JSON.parse(group.scheduleSettings || '{}'); } catch(e){}
    let type = settings[dayIndex];
    if (!type) { if (dayIndex == 2) type = 'tue'; else if (dayIndex == 6) type = 'sat'; else type = 'std'; }
    if (type === 'std') return STATIC_SCHEDULES.std; if (type === 'tue') return STATIC_SCHEDULES.tue; if (type === 'sat') return STATIC_SCHEDULES.sat; if (type === 'short45') return generateShortSchedule(45); if (type === 'short60') return generateShortSchedule(60);
    return STATIC_SCHEDULES.std;
};

// --- ГЕНЕРАТОР КАРТИНКИ ---
const generateTasksImage = (tasks, groupName) => {
    const width = 800;
    const itemHeight = 100;
    const headerHeight = 120;
    const height = headerHeight + (tasks.length * itemHeight) + 50;
    
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');

    // Фон
    ctx.fillStyle = '#181818';
    ctx.fillRect(0, 0, width, height);

    // Заголовок
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 36px Sans';
    ctx.fillText(`📅 Список задач: ${groupName}`, 40, 60);

    // Линия
    ctx.strokeStyle = '#9d4edd'; 
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(40, 90);
    ctx.lineTo(width - 40, 90);
    ctx.stroke();

    if (tasks.length === 0) {
        ctx.fillStyle = '#888';
        ctx.font = '30px Sans';
        ctx.fillText("Задач нет. Можно отдыхать!", 40, 160);
        return canvas.toBuffer();
    }

    let y = 150;
    tasks.forEach((t) => {
        const subj = t.Subject ? t.Subject.name : 'Без предмета';
        const date = moment(t.deadline).format('DD.MM HH:mm');
        const isPersonal = t.isPersonal ? '(Личное)' : '';

        // Подложка
        ctx.fillStyle = '#282828';
        ctx.fillRect(40, y - 40, width - 80, itemHeight - 10);
        
        // Индикатор (зеленый - готово, фиолетовый - в процессе)
        ctx.fillStyle = t.isCompleted ? '#4caf50' : '#9d4edd';
        ctx.fillRect(40, y - 40, 10, itemHeight - 10);

        // Предмет
        ctx.fillStyle = '#b3b3b3';
        ctx.font = '22px Sans';
        ctx.fillText(`${subj} ${isPersonal}`, 70, y - 5);

        // Название задачи
        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 28px Sans';
        ctx.fillText(t.title.length > 35 ? t.title.substring(0,35)+'...' : t.title, 70, y + 30);

        // Дедлайн
        ctx.fillStyle = '#ff5252';
        ctx.font = 'bold 24px Sans';
        ctx.fillText(date, width - 200, y + 10);

        y += itemHeight;
    });

    return canvas.toBuffer();
};

// --- START ---
bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    let [user, created] = await User.findOrCreate({
        where: { telegramId: chatId },
        defaults: { firstName: msg.from.first_name, username: msg.from.username, role: isAdmin(chatId) ? 'admin' : 'student' }
    });
    if (!user.GroupId && user.role !== 'admin') return sendGroupSelection(chatId, 0);
    sendMainMenu(chatId, user, false);
});

function sendMainMenu(chatId, user, messageIdToEdit = null) {
    const keyboard = [
        [{ text: '📅 Задачи', callback_data: 'menu_tasks' }, { text: '➕ Добавить задачу', callback_data: 'add_task_start' }],
        [{ text: '📚 Расписание', callback_data: 'menu_schedule' }], 
        [{ text: '⚙️ Настройки', callback_data: 'menu_settings' }]
    ];
    if (user.role === 'curator' || user.role === 'admin') keyboard.push([{ text: '🎓 Меню Куратора', callback_data: 'menu_curator' }]);
    if (user.role === 'admin') keyboard.push([{ text: '🛡 Админ-панель', callback_data: 'menu_admin' }]);
    keyboard.push([{ text: '🔄 Сменить группу', callback_data: 'change_group' }]);

    const text = `🏠 *Главное меню*\nРоль: ${getRoleText(user.role)}\nГруппа: ${user.GroupId ? 'Выбрана' : 'Не выбрана'}`;
    const opts = { parse_mode: 'Markdown', reply_markup: { inline_keyboard: keyboard } };
    if (messageIdToEdit) bot.editMessageText(text, { chat_id: chatId, message_id: messageIdToEdit, ...opts }).catch(() => {});
    else bot.sendMessage(chatId, text, opts);
}

async function sendGroupSelection(chatId, page = 0, messageIdToEdit = null) {
    const limit = 5; const offset = page * limit;
    const groups = await Group.findAll({ where: { status: 'active' }, limit, offset });
    const keyboard = groups.map(g => [{ text: g.name, callback_data: `select_group_${g.id}` }]);
    const navRow = [];
    if (page > 0) navRow.push({ text: '⬅️', callback_data: `page_group_${page - 1}` });
    navRow.push({ text: '➡️', callback_data: `page_group_${page + 1}` });
    keyboard.push(navRow);
    keyboard.push([{ text: '➕ Создать новую группу', callback_data: 'add_new_group' }]);
    const text = '🎓 Выберите вашу учебную группу:';
    const opts = { reply_markup: { inline_keyboard: keyboard } };
    if (messageIdToEdit) bot.editMessageText(text, { chat_id: chatId, message_id: messageIdToEdit, ...opts }).catch(()=>{});
    else bot.sendMessage(chatId, text, opts);
}

// --- CALLBACKS ---
bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    const msgId = query.message.message_id;
    const data = query.data;

    let user = await User.findOne({ where: { telegramId: chatId } });
    if (!user) return;

    const edit = (text, keyboard) => {
        bot.editMessageText(text, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: keyboard } }).catch(err => console.log('Edit ignored:', err.message));
    };

    if (data === 'back_main') sendMainMenu(chatId, user, msgId);
    if (data === 'clean_menu_start') { bot.deleteMessage(chatId, msgId).catch(()=>{}); sendMainMenu(chatId, user, null); }

    if (data.startsWith('page_group_')) sendGroupSelection(chatId, parseInt(data.split('_')[2]), msgId);
    if (data.startsWith('select_group_')) { await user.update({ GroupId: data.split('_')[2] }); bot.answerCallbackQuery(query.id, { text: 'Группа выбрана' }); sendMainMenu(chatId, user, msgId); }
    if (data === 'change_group') sendGroupSelection(chatId, 0, msgId);
    if (data === 'add_new_group') { userStates[chatId] = { action: 'WAITING_NEW_GROUP_NAME' }; bot.sendMessage(chatId, '✍️ Введите название новой группы:'); bot.deleteMessage(chatId, msgId).catch(()=>{}); }

    if (data === 'menu_settings') {
        let settings = { notify: true, viewMode: 'text' };
        try { settings = JSON.parse(user.settings || '{}'); } catch(e){}
        const notifyText = settings.notify ? '🔔 Уведомления: ВКЛ' : '🔕 Уведомления: ВЫКЛ';
        const viewText = settings.viewMode === 'image' ? '🖼 Вид списков: КАРТИНКА' : '📝 Вид списков: ТЕКСТ';
        edit('⚙️ *Настройки профиля:*', [
            [{ text: notifyText, callback_data: 'toggle_notify' }],
            [{ text: viewText, callback_data: 'toggle_viewmode' }],
            [{ text: '🔙 В главное меню', callback_data: 'back_main' }]
        ]);
    }
    if (data === 'toggle_notify') {
        let settings = { notify: true, viewMode: 'text' }; try { settings = JSON.parse(user.settings || '{}'); } catch(e){}
        settings.notify = !settings.notify;
        await user.update({ settings: JSON.stringify(settings) });
        const fakeQuery = { ...query, data: 'menu_settings' }; bot.emit('callback_query', fakeQuery);
    }
    if (data === 'toggle_viewmode') {
        let settings = { notify: true, viewMode: 'text' }; try { settings = JSON.parse(user.settings || '{}'); } catch(e){}
        settings.viewMode = settings.viewMode === 'image' ? 'text' : 'image';
        await user.update({ settings: JSON.stringify(settings) });
        const fakeQuery = { ...query, data: 'menu_settings' }; bot.emit('callback_query', fakeQuery);
    }

    if (data === 'menu_tasks') {
        let settings = { notify: true, viewMode: 'text' };
        try { settings = JSON.parse(user.settings || '{}'); } catch(e){}

        const tasks = await Task.findAll({
            where: { [Op.or]: [{ isPersonal: true, creatorId: user.id }, { isPersonal: false, GroupId: user.GroupId, status: 'active' }], isCompleted: false },
            order: [['deadline', 'ASC']], include: [Subject]
        });

        // ЕСЛИ РЕЖИМ КАРТИНКИ
        if (settings.viewMode === 'image') {
            bot.deleteMessage(chatId, msgId).catch(()=>{}); 
            const group = await Group.findByPk(user.GroupId);
            const imageBuffer = generateTasksImage(tasks, group ? group.name : 'Личные');
            await bot.sendPhoto(chatId, imageBuffer, {
                caption: '📅 Ваш список задач',
                reply_markup: { inline_keyboard: [[{ text: '🏠 Главное меню', callback_data: 'clean_menu_start' }]] }
            });
            return;
        }

        // ЕСЛИ РЕЖИМ ТЕКСТА
        if (tasks.length === 0) return edit('📭 Задач пока нет.', [[{ text: '🔙 Назад', callback_data: 'back_main' }]]);
        await bot.deleteMessage(chatId, msgId).catch(()=>{});
        for (const t of tasks) {
            const date = moment(t.deadline).format('DD.MM HH:mm');
            const subjName = t.Subject ? t.Subject.name : 'Без предмета';
            const icon = t.isPersonal ? '👤' : '👥';
            await bot.sendMessage(chatId, `${icon} *${t.title}*\n📖 ${subjName} | ⏰ ${date}`, { 
                parse_mode: 'Markdown',
                reply_markup: { inline_keyboard: [[{ text: '✅ Выполнено', callback_data: `done_task_${t.id}` }]] }
            });
        }
        bot.sendMessage(chatId, '---', { reply_markup: { inline_keyboard: [[{ text: '🏠 Главное меню', callback_data: 'clean_menu_start' }]] } });
    }

    if (data.startsWith('done_task_')) {
        const task = await Task.findByPk(data.split('_')[2]);
        if (!task) return bot.deleteMessage(chatId, msgId);
        if (task.isPersonal || user.role === 'curator' || user.role === 'admin') {
            await task.update({ isCompleted: true });
            bot.deleteMessage(chatId, msgId).catch(()=>{});
            bot.answerCallbackQuery(query.id, { text: 'Закрыто' });
        } else {
            bot.answerCallbackQuery(query.id, { text: 'Только Куратор может закрыть это.', show_alert: true });
        }
    }

    if (data === 'add_task_start') {
        if (!user.GroupId && user.role !== 'admin') return bot.answerCallbackQuery(query.id, {text: 'Нет группы!', show_alert: true});
        const subjects = await Subject.findAll({ where: { GroupId: user.GroupId, status: 'active' } });
        const k = subjects.map(s => [{ text: s.name, callback_data: `pick_subj_${s.id}` }]);
        k.push([{ text: '➕ Новый предмет', callback_data: 'pick_subj_new' }]);
        k.push([{ text: '🔙 Назад', callback_data: 'back_main' }]);
        edit('1️⃣ Выберите предмет:', k);
    }
    if (data.startsWith('pick_subj_')) {
        const subjId = data.split('_')[2];
        bot.deleteMessage(chatId, msgId).catch(()=>{});
        if (subjId === 'new') { userStates[chatId] = { action: 'WAITING_SUBJECT_NAME' }; bot.sendMessage(chatId, 'Введите название предмета:'); }
        else { userStates[chatId] = { action: 'WAITING_TASK_TITLE', temp: { subjId } }; bot.sendMessage(chatId, '2️⃣ Введите текст задания:'); }
    }
    if (data.startsWith('save_task_')) {
        const type = data.split('_')[2];
        const state = userStates[chatId];
        if (!state || !state.temp) return;
        const isPersonal = (type === 'personal');
        const isActive = isPersonal || user.role === 'curator' || user.role === 'admin';
        const status = isActive ? 'active' : 'pending';
        await Task.create({ title: state.temp.title, deadline: state.temp.deadline, SubjectId: state.temp.subjId, creatorId: user.id, GroupId: user.GroupId, isPersonal, status });
        delete userStates[chatId]; bot.deleteMessage(chatId, msgId).catch(()=>{});
        if (status === 'pending') {
            bot.sendMessage(chatId, `📩 Отправлено на модерацию.`);
            const curators = await User.findAll({ where: { GroupId: user.GroupId, role: 'curator' } });
            curators.forEach(c => bot.sendMessage(c.telegramId, `📢 *Задача на проверку*\n${state.temp.title}`, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '👀 Проверить', callback_data: 'menu_curator_tasks' }]] } }));
        } else {
            bot.sendMessage(chatId, `✅ Задача сохранена!`);
        }
        sendMainMenu(chatId, user);
    }

    if (data === 'menu_schedule') edit('📅 Выберите период:', [[{ text: 'Сегодня', callback_data: 'sch_show_today' }, { text: 'Завтра', callback_data: 'sch_show_tmrw' }], [{ text: 'Вся неделя', callback_data: 'sch_show_week' }], [{ text: '🔙 Назад', callback_data: 'back_main' }]]);
    const showSchedule = async (targetDay, label) => {
        const lessons = await Lesson.findAll({ where: { GroupId: user.GroupId, dayOfWeek: targetDay }, order: [['startTime', 'ASC']], include: [Subject] });
        let msg = `📅 *${label} (${DAYS[targetDay]})*:\n`;
        if (lessons.length === 0) msg += "Пар нет! Отдыхаем 😴";
        else lessons.forEach(l => { msg += `🔹 *${l.pairNumber} пара* (${l.startTime} - ${l.endTime})\n📖 ${l.Subject.name}\n📍 ${l.room || '—'}\n\n`; });
        edit(msg, [[{ text: '🔙 Назад к расписанию', callback_data: 'menu_schedule' }]]);
    };
    if (data === 'sch_show_today') { let day = new Date().getDay(); if (day === 0) day = 7; await showSchedule(day, 'Сегодня'); }
    if (data === 'sch_show_tmrw') { let day = new Date().getDay() + 1; if (day === 0) day = 7; if (day === 8) day = 1; await showSchedule(day, 'Завтра'); }
    if (data === 'sch_show_week') {
        const lessons = await Lesson.findAll({ where: { GroupId: user.GroupId }, order: [['dayOfWeek', 'ASC'], ['startTime', 'ASC']], include: [Subject] });
        let msg = '📅 *Расписание на неделю:*\n\n';
        if (lessons.length === 0) msg += 'Пусто.';
        let currentDay = 0;
        lessons.forEach(l => { if (l.dayOfWeek !== currentDay) { msg += `🗓 *${DAYS[l.dayOfWeek]}*\n`; currentDay = l.dayOfWeek; } msg += `   ${l.pairNumber}) ${l.startTime}-${l.endTime} | ${l.Subject.name} (${l.room || '-'})\n`; });
        edit(msg, [[{ text: '🔙 Назад', callback_data: 'menu_schedule' }]]);
    }

    if (data === 'menu_curator') edit('🎓 Панель куратора:', [[{ text: '📩 Модерация задач', callback_data: 'menu_curator_tasks' }], [{ text: '📚 Модерация предметов', callback_data: 'menu_curator_subjects' }], [{ text: '⚙️ Настройка звонков', callback_data: 'curator_config_bells' }], [{ text: '➕ Добавить пару', callback_data: 'curator_add_lesson' }], [{ text: '✏️ Редактор расписания', callback_data: 'curator_manage_schedule' }], [{ text: '📢 Рассылка', callback_data: 'curator_broadcast' }], [{ text: '🔙 Назад', callback_data: 'back_main' }]]);
    if (data === 'curator_broadcast') { userStates[chatId] = { action: 'WAITING_BROADCAST_TEXT' }; bot.deleteMessage(chatId, msgId).catch(()=>{}); bot.sendMessage(chatId, '✍️ Введите текст объявления для всей группы:'); }

    // МОДЕРАЦИЯ ЗАДАЧ
    const showPendingTasks = async () => {
        const tasks = await Task.findAll({ where: { GroupId: user.GroupId, status: 'pending' }, include: [Subject] });
        if (!tasks.length) return edit('✅ Все задачи проверены.', [[{ text: '🔙 В меню куратора', callback_data: 'menu_curator' }]]);
        const k = tasks.map(t => [{ text: `${t.Subject ? t.Subject.name : '?'}: ${t.title}`, callback_data: `cur_view_task_${t.id}` }]); k.push([{ text: '🔙 Назад', callback_data: 'menu_curator' }]); edit('📩 *Модерация задач:*\nВыберите задачу:', k);
    };
    if (data === 'menu_curator_tasks') await showPendingTasks();
    if (data.startsWith('cur_view_task_')) {
        const t = await Task.findByPk(data.split('_')[3], { include: [Subject] });
        if (!t) { await showPendingTasks(); return; } 
        edit(`📢 *Задача на проверку*\n\n📖 ${t.Subject ? t.Subject.name : '?'}\n📝 ${t.title}\n⏰ ${moment(t.deadline).format('DD.MM HH:mm')}`, [[{ text: '✅ Одобрить', callback_data: `cur_ok_${t.id}` }], [{ text: '❌ Отклонить', callback_data: `cur_del_${t.id}` }], [{ text: '🔙 К списку', callback_data: 'menu_curator_tasks' }]]);
    }
    if (data.startsWith('cur_ok_')) { 
        const task = await Task.findByPk(data.split('_')[2]);
        if (task) { 
            await task.update({ status: 'active' }); bot.answerCallbackQuery(query.id, { text: 'Одобрено!' }); 
            if (task.creatorId) { const creator = await User.findByPk(task.creatorId); if (creator) bot.sendMessage(creator.telegramId, `✅ *Ваша задача одобрена!*\n📝 ${task.title}`, { parse_mode: 'Markdown' }).catch(()=>{}); }
        }
        await showPendingTasks();
    }
    if (data.startsWith('cur_del_')) { 
        const task = await Task.findByPk(data.split('_')[2]);
        if (task) { 
            if (task.creatorId) { const creator = await User.findByPk(task.creatorId); if (creator) bot.sendMessage(creator.telegramId, `❌ *Ваша задача отклонена.*\n📝 ${task.title}`, { parse_mode: 'Markdown' }).catch(()=>{}); }
            await task.destroy(); 
        }
        bot.answerCallbackQuery(query.id, { text: 'Отклонено!' }); await showPendingTasks();
    }

    const showPendingSubjects = async () => {
        const subjs = await Subject.findAll({ where: { GroupId: user.GroupId, status: 'pending' } });
        if (!subjs.length) return edit('✅ Все предметы проверены.', [[{ text: '🔙 В меню куратора', callback_data: 'menu_curator' }]]);
        const k = subjs.map(s => [{ text: s.name, callback_data: `cur_view_subj_${s.id}` }]); k.push([{ text: '🔙 Назад', callback_data: 'menu_curator' }]); edit('📚 *Модерация предметов:*\nВыберите предмет:', k);
    };
    if (data === 'menu_curator_subjects') await showPendingSubjects();
    if (data.startsWith('cur_view_subj_')) { const s = await Subject.findByPk(data.split('_')[3]); if (!s) { await showPendingSubjects(); return; } edit(`📚 *Предмет на проверку:*\n${s.name}`, [[{ text: '✅ Одобрить', callback_data: `cur_subj_ok_${s.id}` }], [{ text: '❌ Отклонить', callback_data: `cur_subj_del_${s.id}` }], [{ text: '🔙 К списку', callback_data: 'menu_curator_subjects' }]]); }
    if (data.startsWith('cur_subj_ok_')) { await Subject.update({ status: 'active' }, { where: { id: data.split('_')[3] } }); bot.answerCallbackQuery(query.id, { text: 'Одобрено' }); await showPendingSubjects(); }
    if (data.startsWith('cur_subj_del_')) { await Subject.destroy({ where: { id: data.split('_')[3] } }); bot.answerCallbackQuery(query.id, { text: 'Отклонено' }); await showPendingSubjects(); }

    if (data === 'curator_config_bells') {
        const group = await Group.findByPk(user.GroupId); let settings = {}; try { settings = JSON.parse(group.scheduleSettings || '{}'); } catch(e){}
        let msg = "⚙️ *Настройка звонков:*\n\n"; const k = [];
        WORK_DAYS_KEYS.forEach(dk => { let type = settings[dk]; if (!type) { if (dk == 2) type = 'tue'; else if (dk == 6) type = 'sat'; else type = 'std'; } msg += `🔹 ${DAYS[dk]}: ${SCHEDULE_TYPES_NAMES[type] || type}\n`; k.push([{ text: `Изменить ${DAYS[dk]}`, callback_data: `cfg_day_${dk}` }]); });
        k.push([{ text: '🔙 Назад', callback_data: 'menu_curator' }]); edit(msg, k);
    }
    if (data.startsWith('cfg_day_')) { const d = data.split('_')[2]; const k = Object.keys(SCHEDULE_TYPES_NAMES).map(key => [{ text: SCHEDULE_TYPES_NAMES[key], callback_data: `set_day_type_${d}_${key}` }]); k.push([{ text: '🔙 Отмена', callback_data: 'curator_config_bells' }]); edit(`Режим для: *${DAYS[d]}*`, k); }
    if (data.startsWith('set_day_type_')) {
        const d = data.split('_')[3]; const t = data.split('_')[4]; const g = await Group.findByPk(user.GroupId);
        let s = {}; try { s = JSON.parse(g.scheduleSettings || '{}'); } catch(e){} s[d] = t; await g.update({ scheduleSettings: JSON.stringify(s) });
        let newBells = []; if (t === 'std') newBells = STATIC_SCHEDULES.std; else if (t === 'tue') newBells = STATIC_SCHEDULES.tue; else if (t === 'sat') newBells = STATIC_SCHEDULES.sat; else if (t === 'short45') newBells = generateShortSchedule(45); else if (t === 'short60') newBells = generateShortSchedule(60);
        const ls = await Lesson.findAll({ where: { GroupId: user.GroupId, dayOfWeek: d } }); for (let l of ls) { const b = newBells.find(be => be.num === l.pairNumber); if (b) await l.update({ startTime: b.start, endTime: b.end }); }
        bot.answerCallbackQuery(query.id, { text: 'Сохранено' });
        const fakeQuery = { ...query, data: 'curator_config_bells' }; bot.emit('callback_query', fakeQuery);
    }

    if (data === 'curator_add_lesson') { const k = WORK_DAYS_KEYS.map(key => [{ text: DAYS[key], callback_data: `add_lesson_day_${key}` }]); k.push([{ text: '🔙 Назад', callback_data: 'menu_curator' }]); edit('Выберите день:', k); }
    if (data.startsWith('add_lesson_day_')) { const d = data.split('_')[3]; const ss = await Subject.findAll({ where: { GroupId: user.GroupId, status: 'active' } }); const k = ss.map(s => [{ text: s.name, callback_data: `add_lesson_subj_${d}_${s.id}` }]); k.push([{ text: '🔙 Назад', callback_data: 'curator_add_lesson' }]); edit('Выберите предмет:', k); }
    if (data.startsWith('add_lesson_subj_')) {
        const [, , , d, sId] = data.split('_'); const g = await Group.findByPk(user.GroupId); const b = getGroupBells(g, d);
        const k = b.map(bb => [{ text: `${bb.num} пара (${bb.start}-${bb.end})`, callback_data: `save_lesson_data_${d}_${sId}_${bb.num}_${bb.start}_${bb.end}` }]); k.push([{ text: '🔙 Назад', callback_data: `add_lesson_day_${d}` }]); edit('⏰ Выберите время:', k);
    }
    if (data.startsWith('save_lesson_data_')) { const p = data.split('_'); userStates[chatId] = { action: 'WAITING_LESSON_ROOM', temp: { day: p[3], subjId: p[4], pairNumber: parseInt(p[5]), startTime: p[6], endTime: p[7] } }; bot.deleteMessage(chatId, msgId).catch(()=>{}); bot.sendMessage(chatId, `✅ Выбрано: ${p[6]}-${p[7]}.\n🏢 Введите аудиторию:`); }

    if (data === 'curator_manage_schedule') { const k = WORK_DAYS_KEYS.map(key => [{ text: DAYS[key], callback_data: `man_les_day_${key}` }]); k.push([{ text: '🔙 Назад', callback_data: 'menu_curator' }]); edit('Удаление пар:', k); }
    if (data.startsWith('man_les_day_')) {
        const d = data.split('_')[3]; userStates[chatId] = { temp: { editingDay: d } };
        const ls = await Lesson.findAll({ where: { GroupId: user.GroupId, dayOfWeek: d }, order: [['startTime', 'ASC']], include: [Subject] });
        const k = ls.map(l => [{ text: `❌ Удалить: ${l.pairNumber} пара`, callback_data: `del_les_final_${l.id}` }]); k.push([{ text: '🔙 Назад', callback_data: 'curator_manage_schedule' }]); edit(`📅 *${DAYS[d]}*`, k);
    }
    if (data.startsWith('del_les_final_')) { await Lesson.destroy({ where: { id: data.split('_')[3] } }); bot.answerCallbackQuery(query.id, { text: 'Удалено' }); const d = userStates[chatId]?.temp?.editingDay || 1; const fakeQuery = { ...query, data: `man_les_day_${d}` }; bot.emit('callback_query', fakeQuery); }

    const showPendingGroupsList = async () => { const gs = await Group.findAll({where:{status:'pending'}}); if(!gs.length) return edit('✅ Заявок нет.', [[{ text: '🔙 В админку', callback_data: 'menu_admin' }]]); const k = gs.map(g => [{ text: `Группа: ${g.name}`, callback_data: `adm_view_p_grp_${g.id}` }]); k.push([{ text: '🔙 Назад', callback_data: 'menu_admin' }]); edit('⏳ Заявки:', k); };
    if (data === 'menu_admin') edit('🛡 Админ-панель:', [[{ text: '⏳ Заявки групп', callback_data: 'admin_pending_groups' }], [{ text: '👤 Роли', callback_data: 'admin_roles_groups' }], [{ text: '🔙 Главное меню', callback_data: 'back_main' }]]);
    if (data === 'admin_pending_groups') await showPendingGroupsList();
    if (data.startsWith('adm_view_p_grp_')) { const g = await Group.findByPk(data.split('_')[4]); if (!g) { await showPendingGroupsList(); return; } edit(`Группа: ${g.name}`, [[{ text: '✅', callback_data: `adm_grp_ok_${g.id}` }], [{ text: '❌', callback_data: `adm_grp_del_${g.id}` }], [{ text: '🔙', callback_data: 'admin_pending_groups' }]]); }
    if (data.startsWith('adm_grp_ok_')) { await Group.update({status:'active'}, {where:{id:data.split('_')[3]}}); bot.answerCallbackQuery(query.id, { text: 'Ок' }); await showPendingGroupsList(); }
    if (data.startsWith('adm_grp_del_')) { await Group.destroy({where:{id:data.split('_')[3]}}); bot.answerCallbackQuery(query.id, { text: 'Удалено' }); await showPendingGroupsList(); }
    if (data === 'admin_roles_groups') { const gs = await Group.findAll({where:{status:'active'}}); const k=gs.map(g=>[{text:g.name,callback_data:`adm_r_g_${g.id}`}]); k.push([{text:'🔙',callback_data:'menu_admin'}]); edit('Группа:', k); }
    if (data.startsWith('adm_r_g_')) { const us=await User.findAll({where:{GroupId:data.split('_')[3]}}); if(!us.length)return bot.answerCallbackQuery(query.id,{text:'Пусто'}); const k=us.map(u=>[{text:`${u.firstName} (${u.role})`,callback_data:`adm_r_u_${u.id}`}]); k.push([{text:'🔙',callback_data:'admin_roles_groups'}]); edit('Пользователь:', k); }
    if (data.startsWith('adm_r_u_')) { const uid=data.split('_')[3]; const u=await User.findByPk(uid); edit(`${u.firstName}:`, [[{text:'Студент',callback_data:`set_role_${uid}_student`}], [{text:'Куратор',callback_data:`set_role_${uid}_curator`}], [{text:'Админ',callback_data:`set_role_${uid}_admin`}], [{text:'🔙',callback_data:`adm_r_g_${u.GroupId}`}]]); }
    if (data.startsWith('set_role_')) { const uid=data.split('_')[2]; const r=data.split('_')[3]; await User.update({role:r},{where:{id:uid}}); bot.answerCallbackQuery(query.id,{text:'Обновлено'}); const u=await User.findByPk(uid); const f={...query,data:`adm_r_g_${u.GroupId}`}; bot.emit('callback_query',f); }
});

bot.on('message', async (msg) => {
    const chatId = msg.chat.id; const text = msg.text;
    if (text && text.startsWith('/')) return;
    if (!userStates[chatId]) return;
    const state = userStates[chatId];
    bot.deleteMessage(chatId, msg.message_id).catch(()=>{});

    if (state.action === 'WAITING_NEW_GROUP_NAME') { await Group.create({ name: text, status: 'pending' }); delete userStates[chatId]; bot.sendMessage(chatId, '✅ Заявка отправлена.'); sendGroupSelection(chatId, 0); }
    if (state.action === 'WAITING_SUBJECT_NAME') {
        const user = await User.findOne({ where: { telegramId: chatId } }); const status = (user.role === 'curator' || user.role === 'admin') ? 'active' : 'pending';
        const s = await Subject.create({ name: text, GroupId: user.GroupId, status });
        if (status === 'active') { userStates[chatId] = { action: 'WAITING_TASK_TITLE', temp: { subjId: s.id } }; bot.sendMessage(chatId, 'Предмет добавлен. Задание:'); } 
        else { delete userStates[chatId]; bot.sendMessage(chatId, 'Предмет на модерации.'); sendMainMenu(chatId, user); }
    }
    if (state.action === 'WAITING_TASK_TITLE') { state.temp.title = text; state.action = 'WAITING_TASK_DEADLINE'; bot.sendMessage(chatId, `Дедлайн (ДД.ММ.ГГГГ ЧЧ:ММ):\nПример: ${moment().add(1,'d').format('DD.MM.YYYY 18:00')}`); }
    else if (state.action === 'WAITING_TASK_DEADLINE') {
        const d = moment(text, 'DD.MM.YYYY HH:mm', true); if (!d.isValid()) return bot.sendMessage(chatId, '❌ Некорректная дата.');
        state.temp.deadline = d.toDate();
        const user = await User.findOne({ where: { telegramId: chatId } }); const k = [[{ text: 'Личная', callback_data: 'save_task_personal' }]];
        if (user.role !== 'student') k.push([{ text: 'Для группы', callback_data: 'save_task_group' }]); else k.push([{ text: 'Предложить группе', callback_data: 'save_task_group' }]);
        bot.sendMessage(chatId, 'Тип задачи:', { reply_markup: { inline_keyboard: k } });
    }
    else if (state.action === 'WAITING_LESSON_ROOM') {
        const user = await User.findOne({ where: { telegramId: chatId } });
        const ex = await Lesson.findOne({ where: { GroupId: user.GroupId, dayOfWeek: state.temp.day, pairNumber: state.temp.pairNumber } });
        if (ex) { await ex.update({ SubjectId: state.temp.subjId, startTime: state.temp.startTime, endTime: state.temp.endTime, room: text }); bot.sendMessage(chatId, '🔄 Обновлено!'); }
        else { await Lesson.create({ dayOfWeek: state.temp.day, SubjectId: state.temp.subjId, startTime: state.temp.startTime, endTime: state.temp.endTime, pairNumber: state.temp.pairNumber, room: text, GroupId: user.GroupId }); bot.sendMessage(chatId, '✅ Добавлено!'); }
        delete userStates[chatId]; sendMainMenu(chatId, user);
    }
    else if (state.action === 'WAITING_BROADCAST_TEXT') {
        const user = await User.findOne({ where: { telegramId: chatId } }); const users = await User.findAll({ where: { GroupId: user.GroupId } });
        for (const u of users) { bot.sendMessage(u.telegramId, `📢 *Объявление от куратора:*\n\n${text}`, { parse_mode: 'Markdown' }).catch(()=>{}); }
        delete userStates[chatId]; bot.sendMessage(chatId, `✅ Отправлено ${users.length} студентам.`); sendMainMenu(chatId, user);
    }
});