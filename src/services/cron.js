const cron = require('node-cron');
const { Op } = require('sequelize');
const moment = require('moment');
const { Task, User, Group } = require('../models');

module.exports = (bot) => {
    // Запускаем проверку каждый час
    cron.schedule('0 * * * *', async () => {
        console.log('⏰ Checking deadlines...');
        const now = moment();
        
        const tasks = await Task.findAll({
            where: {
                isCompleted: false,
                status: 'active',
                deadline: { [Op.gt]: now.toDate() }
            },
            include: [Group]
        });

        for (const task of tasks) {
            const deadline = moment(task.deadline);
            const diffDays = deadline.diff(now, 'days');
            
            let message = '';
            let updateData = {};
            let shouldSend = false;

            // 1. Уведомление за неделю (7-4 дня)
            if (diffDays <= 7 && diffDays > 3 && !task.notifiedWeek) {
                message = `📅 Напоминание! До дедлайна "${task.title}" осталась неделя.`;
                updateData.notifiedWeek = true;
                shouldSend = true;
            }

            // 2. Уведомление за 3 дня и меньше
            if (diffDays <= 3 && !task.notifiedThreeDays) {
                message = `🔥 Горит дедлайн! "${task.title}" - осталось менее 3 дней (${deadline.format('DD.MM HH:mm')})`;
                updateData.notifiedThreeDays = true;
                shouldSend = true;
            }

            if (shouldSend && message) {
                if (task.isPersonal) {
                    const user = await User.findByPk(task.creatorId);
                    if (user) bot.sendMessage(user.telegramId, message).catch(() => {});
                } else if (task.GroupId) {
                    const users = await User.findAll({ where: { GroupId: task.GroupId } });
                    users.forEach(u => bot.sendMessage(u.telegramId, message).catch(() => {}));
                }
                await task.update(updateData);
            }
        }
    });
};