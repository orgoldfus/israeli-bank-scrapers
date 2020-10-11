import moment, { Moment } from 'moment';
import { Page } from 'puppeteer';
import { BaseScraperWithBrowser, LoginResults, LoginOptions } from './base-scraper-with-browser';
import {
  dropdownSelect,
  dropdownElements,
  fillInput,
  clickButton,
  waitUntilElementFound,
  pageEvalAll,
  elementPresentOnPage,
} from '../helpers/elements-interactions';
import { waitForNavigation } from '../helpers/navigation';
import { SHEKEL_CURRENCY } from '../constants';
import {
  TransactionsAccount, Transaction, TransactionStatuses, TransactionTypes,
} from '../transactions';
import { ScaperScrapingResult, ScraperCredentials } from './base-scraper';

const BASE_URL = 'https://hb2.bankleumi.co.il';
const DATE_FORMAT = 'DD/MM/YY';
const NO_TRANSACTION_IN_DATE_RANGE_TEXT = 'לא קיימות תנועות מתאימות על פי הסינון שהוגדר';
const ACCOUNT_BLOCKED_MSG = 'המנוי חסום';

function getTransactionsUrl() {
  return `${BASE_URL}/eBanking/SO/SPA.aspx#/ts/CardsWorld`;
}

function getPossibleLoginResults() {
  const urls: LoginOptions['possibleResults'] = {};
  urls[LoginResults.Success] = [/ebanking\/SO\/SPA.aspx/i];
  urls[LoginResults.InvalidPassword] = [/InternalSite\/CustomUpdate\/leumi\/LoginPage.ASP/];
  urls[LoginResults.AccountBlocked] = [async (options) => {
    if (!options || !options.page) {
      throw new Error('missing page options argument');
    }
    const errorMessage = await pageEvalAll(options.page, '.errHeader', [], (label) => {
      return (label[0] as HTMLElement).innerText;
    });

    return errorMessage.startsWith(ACCOUNT_BLOCKED_MSG);
  }];
  // urls[LOGIN_RESULT.CHANGE_PASSWORD] = ``; // TODO should wait until my password expires
  return urls;
}

function createLoginFields(credentials: ScraperCredentials) {
  return [
    { selector: '#wtr_uid', value: credentials.username },
    { selector: '#wtr_password', value: credentials.password },
  ];
}

function getAmountData(amountStr: string) {
  const amountStrCopy = amountStr.replace(',', '');
  const amount = parseFloat(amountStrCopy);
  const currency = SHEKEL_CURRENCY;

  return {
    amount,
    currency,
  };
}

interface ScrapedTransaction {
  status: TransactionStatuses;
  description?: string;
  memo?: string;
  balance?: string;
  credit?: string;
  debit?: string;
  reference?: string;
  date?: string;
}

function convertTransactions(txns: ScrapedTransaction[]): Transaction[] {
  return txns.map((txn) => {
    const txnDate = moment(txn.date, DATE_FORMAT).toISOString();

    const credit = getAmountData(txn.credit || '').amount;
    const debit = getAmountData(txn.debit || '').amount;
    const amount = (Number.isNaN(credit) ? 0 : credit) - (Number.isNaN(debit) ? 0 : debit);

    const transaction: Transaction = {
      type: TransactionTypes.Normal,
      identifier: txn.reference ? parseInt(txn.reference, 10) : undefined,
      date: txnDate,
      processedDate: txnDate,
      originalAmount: amount,
      originalCurrency: SHEKEL_CURRENCY,
      chargedAmount: amount,
      status: txn.status,
      description: txn.description || '',
      memo: txn.memo || '',
    };
    return transaction;
  });
}
interface ScrapedTds {
  classList: string;
  innerText: string;
}

async function extractCompletedTransactionsFromPage(page: Page): Promise<ScrapedTransaction[]> {
  const txns: ScrapedTransaction[] = [];
  const tdsValues = await pageEvalAll<ScrapedTds[]>(page, '#WorkSpaceBox #ctlActivityTable tr td', [], (tds) => {
    return tds.map((td) => ({
      classList: td.getAttribute('class') || '',
      innerText: (td as HTMLElement).innerText,
    }));
  });

  for (const element of tdsValues) {
    if (element.classList.includes('ExtendedActivityColumnDate')) {
      const newTransaction: ScrapedTransaction = { status: TransactionStatuses.Completed };
      newTransaction.date = (element.innerText || '').trim();
      txns.push(newTransaction);
    } else {
      const changedTransaction = txns.length ? txns.pop() : null;
      if (changedTransaction) {
        if (element.classList.includes('ActivityTableColumn1LTR') || element.classList.includes('ActivityTableColumn1')) {
          changedTransaction.description = element.innerText;
        } else if (element.classList.includes('ReferenceNumberUniqeClass')) {
          changedTransaction.reference = element.innerText;
        } else if (element.classList.includes('AmountDebitUniqeClass')) {
          changedTransaction.debit = element.innerText;
        } else if (element.classList.includes('AmountCreditUniqeClass')) {
          changedTransaction.credit = element.innerText;
        } else if (element.classList.includes('number_column')) {
          changedTransaction.balance = element.innerText;
        } else if (element.classList.includes('tdDepositRowAdded')) {
          changedTransaction.memo = (element.innerText || '').trim();
        }
        txns.push(changedTransaction);
      }
    }
  }

  return txns;
}

async function extractPendingTransactionsFromPage(page: Page): Promise<ScrapedTransaction[]> {
  const txns: ScrapedTransaction[] = [];
  const tdsValues = await pageEvalAll<ScrapedTds[]>(page, '#WorkSpaceBox table#ctlTodayActivityTableUpper tr td', [], (tds) => {
    return tds.map((td) => ({
      classList: td.getAttribute('class') || '',
      innerText: (td as HTMLElement).innerText,
    }));
  });

  for (const element of tdsValues) {
    if (element.classList.includes('Colume1Width')) {
      const newTransaction: ScrapedTransaction = { status: TransactionStatuses.Pending };
      newTransaction.date = (element.innerText || '').trim();
      txns.push(newTransaction);
    } else {
      const changedTransaction = txns.length ? txns.pop() : null;

      if (changedTransaction) {
        if (element.classList.includes('Colume2Width')) {
          changedTransaction.description = element.innerText;
        } else if (element.classList.includes('Colume3Width')) {
          changedTransaction.reference = element.innerText;
        } else if (element.classList.includes('Colume4Width')) {
          changedTransaction.debit = element.innerText;
        } else if (element.classList.includes('Colume5Width')) {
          changedTransaction.credit = element.innerText;
        } else if (element.classList.includes('Colume6Width')) {
          changedTransaction.balance = element.innerText;
        }
        txns.push(changedTransaction);
      }
    }
  }

  return txns;
}

async function isNoTransactionInDateRangeError(page: Page) {
  const hasErrorInfoElement = await elementPresentOnPage(page, '.errInfo');
  if (hasErrorInfoElement) {
    const errorText = await page.$eval('.errInfo', (errorElement) => {
      return (errorElement as HTMLElement).innerText;
    });
    return errorText === NO_TRANSACTION_IN_DATE_RANGE_TEXT;
  }
  return false;
}

async function fetchTransactionsForAccount(page: Page, startDate: Moment, accountId: string): Promise<TransactionsAccount> {
  await dropdownSelect(page, 'select#ddlAccounts_m_ddl', accountId);
  await dropdownSelect(page, 'select#ddlTransactionPeriod', '004');
  await waitUntilElementFound(page, 'select#ddlTransactionPeriod');
  await fillInput(
    page,
    'input#dtFromDate_textBox',
    startDate.format(DATE_FORMAT),
  );
  await clickButton(page, 'input#btnDisplayDates');
  await waitForNavigation(page);

  const selectedSnifAccount = await page.$eval('#ddlAccounts_m_ddl option[selected="selected"]', (option) => {
    return (option as HTMLElement).innerText;
  });

  const accountNumber = selectedSnifAccount.replace('/', '_');

  await Promise.race([
    waitUntilElementFound(page, 'table#WorkSpaceBox table#ctlActivityTable', false),
    waitUntilElementFound(page, '.errInfo', false),
  ]);

  if (await isNoTransactionInDateRangeError(page)) {
    return {
      accountNumber,
      txns: [],
    };
  }

  const hasExpandAllButton = await elementPresentOnPage(page, 'a#lnkCtlExpandAllInPage');

  if (hasExpandAllButton) {
    await clickButton(page, 'a#lnkCtlExpandAllInPage');
  }

  const pendingTxns = await extractPendingTransactionsFromPage(page);
  const completedTxns = await extractCompletedTransactionsFromPage(page);
  const txns = [
    ...pendingTxns,
    ...completedTxns,
  ];

  return {
    accountNumber,
    txns: convertTransactions(txns),
  };
}

async function fetchTransactions(page: Page, startDate: Moment) {
  const res: TransactionsAccount[] = [];
  // Loop through all available accounts and collect transactions from all
  const accounts = await dropdownElements(page, 'select#ddlAccounts_m_ddl');
  for (const account of accounts) {
    // Skip "All accounts" option
    if (account.value !== '-1') {
      res.push(await fetchTransactionsForAccount(page, startDate, account.value));
    }
  }
  return res;
}

async function waitForPostLogin(page: Page): Promise<void> {
  // TODO check for condition to provide new password
  await Promise.race([
    waitUntilElementFound(page, 'div.leumi-container', true),
    waitUntilElementFound(page, '#BodyContent_ctl00_loginErrMsg', true),
    waitUntilElementFound(page, '.ErrMsg', true),
  ]);
}

class LeumiCreditCardScraper extends BaseScraperWithBrowser {
  getLoginOptions(credentials: Record<string, string>) {
    return {
      loginUrl: `${BASE_URL}`,
      fields: createLoginFields(credentials),
      submitButtonSelector: '#enter',
      postAction: async () => waitForPostLogin(this.page),
      possibleResults: getPossibleLoginResults(),
    };
  }

  async fetchData(): Promise<ScaperScrapingResult> {
    const defaultStartMoment = moment().subtract(1, 'years').add(1, 'day');
    const startDate = this.options.startDate || defaultStartMoment.toDate();
    const startMoment = moment.max(defaultStartMoment, moment(startDate));

    const url = getTransactionsUrl();
    await this.navigateTo(url);

    const accounts = await fetchTransactions(this.page, startMoment);

    return {
      success: true,
      accounts,
    };
  }
}

export default LeumiCreditCardScraper;
