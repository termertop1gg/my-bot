const { DataTypes } = require('sequelize');
const sequelize = require('../config/db'); // Проверьте путь до вашего db.js

// 1. Группы
const Group = sequelize.define('Group', {
    name: { type: DataTypes.STRING, allowNull: false },
    status: { type: DataTypes.ENUM('active', 'pending'), defaultValue: 'pending' },
    scheduleSettings: { type: DataTypes.TEXT, defaultValue: '{}' } 
});

// 2. Пользователи
const User = sequelize.define('User', {
    telegramId: { type: DataTypes.BIGINT, unique: true, allowNull: false },
    firstName: { type: DataTypes.STRING },
    username: { type: DataTypes.STRING },
    role: { type: DataTypes.ENUM('student', 'curator', 'admin'), defaultValue: 'student' },
    // НОВОЕ ПОЛЕ: Настройки (JSON строка)
    // notify: true/false, viewMode: 'text'/'image'
    settings: { type: DataTypes.TEXT, defaultValue: '{"notify":true,"viewMode":"text"}' }
});

// 3. Предметы
const Subject = sequelize.define('Subject', {
    name: { type: DataTypes.STRING, allowNull: false },
    status: { type: DataTypes.ENUM('active', 'pending'), defaultValue: 'active' }
});

// 4. Задачи
const Task = sequelize.define('Task', {
    title: { type: DataTypes.STRING, allowNull: false },
    description: { type: DataTypes.TEXT },
    deadline: { type: DataTypes.DATE, allowNull: false },
    isPersonal: { type: DataTypes.BOOLEAN, defaultValue: true }, 
    status: { type: DataTypes.ENUM('active', 'pending'), defaultValue: 'active' }, 
    isCompleted: { type: DataTypes.BOOLEAN, defaultValue: false },
    notifiedWeek: { type: DataTypes.BOOLEAN, defaultValue: false },
    notifiedThreeDays: { type: DataTypes.BOOLEAN, defaultValue: false }
});

// 5. Расписание
const Lesson = sequelize.define('Lesson', {
    dayOfWeek: { type: DataTypes.INTEGER, allowNull: false },
    pairNumber: { type: DataTypes.INTEGER, defaultValue: 0 },
    startTime: { type: DataTypes.STRING, allowNull: false }, 
    endTime: { type: DataTypes.STRING, allowNull: false },   
    room: { type: DataTypes.STRING }
});

// Связи
Group.hasMany(User); User.belongsTo(Group);
Group.hasMany(Subject); Subject.belongsTo(Group);
User.hasMany(Task, { as: 'CreatedTasks', foreignKey: 'creatorId' });
Group.hasMany(Task); Task.belongsTo(Group); Task.belongsTo(Subject);
Group.hasMany(Lesson); Lesson.belongsTo(Group);
Subject.hasMany(Lesson); Lesson.belongsTo(Subject);

sequelize.sync({ alter: true }).then(() => console.log('✅ Модели синхронизированы'));

module.exports = { User, Group, Subject, Task, Lesson };