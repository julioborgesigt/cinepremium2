module.exports = (sequelize, DataTypes) => {
  const PurchaseHistory = sequelize.define('PurchaseHistory', {
    nome: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    telefone: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    transactionId: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    status: {
      type: DataTypes.STRING,
      allowNull: false,
      defaultValue: 'Gerado',
    },
    dataTransacao: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: DataTypes.NOW,
    },
    // Novo campo para contar as verificações já realizadas
    checkCount: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
    }
  }, {
    tableName: 'purchase_histories',
    timestamps: false
  });
  return PurchaseHistory;
};
